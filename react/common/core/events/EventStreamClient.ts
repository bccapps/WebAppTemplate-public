/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { computeBackoff } from './backoff';
import { readSse, SseParser, type SseMessage } from './sseParser';
import type { ServerEvent, ServerEventHandler, StreamState, SubscribeOptions } from './types';

/** Everything the client needs from its environment; the defaults are wired in `eventStream.ts`. */
export interface EventStreamDeps {
  streamGet(
    url: string,
    options: { signal: AbortSignal; headers: Record<string, string> },
  ): Promise<ReadableStream<Uint8Array>>;
  /** API base, e.g. `/api/v1`. */
  baseUrl(): string;
  /** Uniform random in [0, 1). */
  random(): number;
  /** Subscribes to user changes: `null` = signed out, otherwise an identity string. Returns the unsubscribe. */
  watchSession(listener: (identity: string | null) => void): () => void;
  /** Subscribes to access-token refreshes. Returns the unsubscribe. */
  watchTokenRefresh(listener: () => void): () => void;
}

export const SUBSCRIPTION_GROUP_MS = 50;
export const MAX_FAILURES_BEFORE_FALLBACK = 3;
/** An `expired` frame sooner than this after opening counts as a failure (avoids a hot reconnection loop). */
const MIN_HEALTHY_MS = 5000;

type Outcome = 'ended' | 'expired' | 'failed' | 'unavailable';

interface Subscription {
  topics: string[];
  handler: ServerEventHandler;
  onResync?: () => void;
  onDenied?: (denied: string[]) => void;
  /** Last denied list delivered to `onDenied`, as a key. */
  deniedKey: string;
}

/**
 * One Server-Sent Events connection per tab, shared by every subscriber. Subscriptions are reference counted per
 * topic and grouped (50 ms); the connection is reopened when the set of topics changes. Reconnects with a 1 s to 30 s
 * backoff and `Last-Event-ID`; reports `fallback` after 3 failures, on 404 (module absent) and while the server
 * transport is degraded, so that callers can poll instead.
 */
export class EventStreamClient {
  private readonly subscriptions = new Set<Subscription>();
  private readonly refCounts = new Map<string, number>();
  private readonly stateListeners = new Set<(state: StreamState) => void>();
  private readonly cleanups: Array<() => void>;
  private state: StreamState = 'connecting';
  private groupTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private parser = new SseParser();
  private generation = 0;
  private activeKey = '';
  private lastEventId: string | undefined;
  private failures = 0;
  private connected = false;
  private degraded = false;
  private unavailable = false;
  private signedOut = false;
  private expired = false;
  private openedAt = 0;
  private identity: string | null | undefined;
  private denied = new Set<string>();

  constructor(private readonly deps: EventStreamDeps) {
    this.cleanups = [
      deps.watchSession((identity) => this.onSession(identity)),
      deps.watchTokenRefresh(() => this.onTokenRefreshed()),
    ];
  }

  /** Follows `topics` until the returned function is called. Cheap: identical topics share the connection. */
  subscribe(topics: string[], handler: ServerEventHandler, options: SubscribeOptions = {}): () => void {
    const subscription: Subscription = { topics: [...new Set(topics)], handler, onResync: options.onResync, onDenied: options.onDenied, deniedKey: '' };
    subscription.deniedKey = this.deniedOf(subscription).join(',');
    this.subscriptions.add(subscription);
    subscription.topics.forEach((t) => this.refCounts.set(t, (this.refCounts.get(t) ?? 0) + 1));
    this.scheduleSync();
    return () => this.unsubscribe(subscription);
  }

  getState(): StreamState {
    return this.state;
  }

  onStateChange(listener: (state: StreamState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** The topics among `topics` that the server refused on the current connection (empty until `ready`). */
  getDeniedTopics(topics: string[]): string[] {
    return topics.filter((topic) => this.denied.has(topic));
  }

  /** Number of subscriptions currently following `topic`. */
  getTopicRefCount(topic: string): number {
    return this.refCounts.get(topic) ?? 0;
  }

  /** Closes everything and detaches from the environment (tests, hot reload). */
  dispose(): void {
    this.cleanups.forEach((cleanup) => cleanup());
    this.subscriptions.clear();
    this.refCounts.clear();
    this.stop();
  }

  private unsubscribe(subscription: Subscription): void {
    if (!this.subscriptions.delete(subscription)) return;
    subscription.topics.forEach((t) => {
      const left = (this.refCounts.get(t) ?? 1) - 1;
      if (left <= 0) this.refCounts.delete(t);
      else this.refCounts.set(t, left);
    });
    this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.groupTimer) clearTimeout(this.groupTimer);
    this.groupTimer = setTimeout(() => {
      this.groupTimer = null;
      this.sync();
    }, SUBSCRIPTION_GROUP_MS);
  }

  private wantedKey(): string {
    return [...this.refCounts.keys()].sort().join(',');
  }

  /** Reconciles the connection with the wanted topics. */
  private sync(): void {
    const key = this.wantedKey();
    if (key === '' || this.signedOut) return this.stop();
    if (this.unavailable) return;
    if (key === this.activeKey && (this.abort || this.retryTimer)) return;
    this.restart();
  }

  /** Aborts the current connection (if any) and opens a new one right away. */
  private restart(): void {
    this.halt();
    this.launch();
  }

  private stop(): void {
    this.halt();
    this.activeKey = '';
    this.failures = 0;
    this.degraded = false;
    this.refreshState();
  }

  private halt(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connected = false;
    this.refreshState();
  }

  private launch(): void {
    this.retryTimer = null;
    const key = this.wantedKey();
    if (key === '' || this.signedOut || this.unavailable) return this.stop();
    this.activeKey = key;
    this.parser = new SseParser();
    this.expired = false;
    void this.attempt(this.generation, key);
  }

  private async attempt(generation: number, key: string): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    const headers: Record<string, string> = {};
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    const url = `${this.deps.baseUrl()}/events/stream?topics=${encodeURIComponent(key).replace(/%2C/g, ',').replace(/%3A/g, ':')}`;
    let outcome: Outcome;
    try {
      const stream = await this.deps.streamGet(url, { signal: controller.signal, headers });
      if (generation !== this.generation) return;
      await readSse(stream, this.parser, (message) => this.onMessage(message));
      outcome = this.expired ? 'expired' : this.connected ? 'ended' : 'failed';
    } catch (error) {
      outcome = (error as { status?: number })?.status === 404 ? 'unavailable' : 'failed';
    }
    if (generation !== this.generation) return;
    this.abort = null;
    this.connected = false;
    this.afterAttempt(outcome);
  }

  private afterAttempt(outcome: Outcome): void {
    if (outcome === 'unavailable') {
      this.unavailable = true;
      return this.refreshState();
    }
    const healthy = Date.now() - this.openedAt >= MIN_HEALTHY_MS;
    if (outcome === 'failed' || (outcome === 'expired' && !healthy)) this.failures += 1;
    let delay: number;
    if (outcome === 'expired' && healthy) delay = 0;
    else if (outcome === 'ended') delay = this.parser.retryMs ?? computeBackoff(0, this.deps.random);
    else delay = Math.max(computeBackoff(this.failures - 1, this.deps.random), this.parser.retryMs ?? 0);
    this.refreshState();
    this.retryTimer = setTimeout(() => this.launch(), delay);
  }

  private onMessage(message: SseMessage): void {
    if (message.id) this.lastEventId = message.id;
    const payload = parseJson(message.data);
    if (message.event === 'ready') this.onReady(payload);
    else if (message.event === 'event') this.dispatch(payload as ServerEvent | null);
    else if (message.event === 'transport') this.setDegraded(readState(payload) === 'degraded');
    else if (message.event === 'resync') this.notifyResync();
    else if (message.event === 'expired') this.expired = true;
  }

  private onReady(payload: unknown): void {
    this.connected = true;
    this.failures = 0;
    this.openedAt = Date.now();
    this.degraded = (payload as { transport?: string } | null)?.transport === 'degraded';
    this.setDenied((payload as { denied?: unknown } | null)?.denied);
    this.refreshState();
  }

  private setDenied(list: unknown): void {
    this.denied = new Set(Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : []);
    this.notifyDenied();
  }

  private deniedOf(subscription: Subscription): string[] {
    return subscription.topics.filter((topic) => this.denied.has(topic));
  }

  private notifyDenied(): void {
    for (const subscription of [...this.subscriptions]) {
      const denied = this.deniedOf(subscription);
      const key = denied.join(',');
      if (key === subscription.deniedKey) continue;
      subscription.deniedKey = key;
      try {
        subscription.onDenied?.(denied);
      } catch (error) {
        console.warn('[EventStreamClient] denied handler failed', error);
      }
    }
  }

  private setDegraded(degraded: boolean): void {
    this.degraded = degraded;
    this.refreshState();
  }

  private dispatch(event: ServerEvent | null): void {
    if (!event || typeof event.topic !== 'string') return;
    for (const subscription of [...this.subscriptions]) {
      if (!subscription.topics.includes(event.topic)) continue;
      try {
        subscription.handler(event);
      } catch (error) {
        console.warn('[EventStreamClient] handler failed', error);
      }
    }
  }

  private notifyResync(): void {
    for (const subscription of [...this.subscriptions]) {
      try {
        subscription.onResync?.();
      } catch (error) {
        console.warn('[EventStreamClient] resync handler failed', error);
      }
    }
  }

  private refreshState(): void {
    const wanted = this.activeKey !== '' && !this.signedOut;
    let next: StreamState = 'connecting';
    if (wanted && (this.unavailable || this.degraded || this.failures >= MAX_FAILURES_BEFORE_FALLBACK)) next = 'fallback';
    else if (wanted && this.connected) next = 'open';
    if (next === this.state) return;
    this.state = next;
    [...this.stateListeners].forEach((listener) => listener(next));
  }

  private onTokenRefreshed(): void {
    if (this.connected) this.restart();
  }

  private onSession(identity: string | null): void {
    if (identity === this.identity) return;
    this.identity = identity;
    this.signedOut = identity === null;
    this.lastEventId = undefined;
    this.unavailable = false;
    this.failures = 0;
    this.setDenied([]);
    if (this.signedOut) return this.stop();
    this.restart();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readState(payload: unknown): string | undefined {
  return (payload as { state?: string } | null)?.state;
}
