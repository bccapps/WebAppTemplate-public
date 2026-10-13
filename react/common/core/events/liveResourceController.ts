/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ServerEvent, StreamState, ServerEventHandler, SubscribeOptions } from './types';

export const LIVE_REFETCH_GROUP_MS = 250;

/** The slice of `EventStreamClient` a live resource needs (lets tests inject a fake). */
export interface LiveStreamSource {
  subscribe(topics: string[], handler: ServerEventHandler, options?: SubscribeOptions): () => void;
  getState(): StreamState;
  onStateChange(listener: (state: StreamState) => void): () => void;
  /** Topics among `topics` refused by the server on the current connection (optional: absent = none). */
  getDeniedTopics?(topics: string[]): string[];
}

export interface LiveResourceControllerOptions {
  topics: string[];
  /** Only events for which this returns true trigger a refetch (default: every event of the topics). */
  match?: (event: ServerEvent) => boolean;
  /** Polling interval while the stream is in `fallback` or while one of `topics` is refused. 0 disables polling. */
  fallbackPollMs: number;
  /** Refetch when the server asks for a resync and when the stream comes back from `fallback` (default true). */
  refetchOnResync?: boolean;
}

export interface LiveResourceControllerDeps {
  source: LiveStreamSource;
  /** Performs one read; must not throw (the hook stores errors itself). */
  load: () => Promise<void>;
  isVisible: () => boolean;
  /** Registers a callback fired when the tab becomes visible again. Returns the unsubscribe. */
  watchVisible: (listener: () => void) => () => void;
}

/**
 * Framework-free core of `useLiveResource`: loads once, refetches (grouped over 250 ms, never two reads at a time)
 * on matching events, on resync, on return to the tab and on leaving `fallback`, and polls while in `fallback`.
 */
export class LiveResourceController {
  private readonly cleanups: Array<() => void> = [];
  private groupTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private dirty = false;
  private stopped = false;
  private lastState: StreamState = 'connecting';
  /** Topics of this resource the server refused: they never receive events, so the resource is polled. */
  private deniedTopics: string[] = [];

  constructor(
    private readonly options: LiveResourceControllerOptions,
    private readonly deps: LiveResourceControllerDeps,
  ) {}

  start(): void {
    const { source } = this.deps;
    this.lastState = source.getState();
    const refetchOnResync = this.options.refetchOnResync !== false;
    this.cleanups.push(
      source.subscribe(this.options.topics, (event) => this.onEvent(event), {
        onResync: () => refetchOnResync && this.schedule(),
        onDenied: (denied) => this.onDenied(denied),
      }),
      source.onStateChange((state) => this.onState(state)),
      this.deps.watchVisible(() => this.schedule()),
    );
    this.deniedTopics = source.getDeniedTopics?.(this.options.topics) ?? [];
    this.applyPolling(this.lastState);
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    if (this.groupTimer) clearTimeout(this.groupTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.groupTimer = null;
    this.pollTimer = null;
  }

  /** Reads now (still serialised with reads in flight). */
  refresh(): Promise<void> {
    return this.run();
  }

  private onEvent(event: ServerEvent): void {
    if (!this.options.match || this.options.match(event)) this.schedule();
  }

  private onState(state: StreamState): void {
    const left = this.lastState === 'fallback' && state !== 'fallback';
    this.lastState = state;
    this.applyPolling(state);
    if (left && this.options.refetchOnResync !== false) this.schedule();
  }

  private onDenied(denied: string[]): void {
    this.deniedTopics = denied;
    this.applyPolling(this.lastState);
  }

  private applyPolling(state: StreamState): void {
    const needed = state === 'fallback' || this.deniedTopics.length > 0;
    const wanted = needed && this.options.fallbackPollMs > 0;
    if (!wanted && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    } else if (wanted && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        if (this.deps.isVisible()) void this.run();
      }, this.options.fallbackPollMs);
    }
  }

  /** Groups bursts: the first trigger arms the timer, the following ones within the window are absorbed. */
  private schedule(): void {
    if (this.stopped || this.groupTimer) return;
    this.groupTimer = setTimeout(() => {
      this.groupTimer = null;
      void this.run();
    }, LIVE_REFETCH_GROUP_MS);
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    this.inFlight = true;
    try {
      await this.deps.load();
    } finally {
      this.inFlight = false;
    }
    if (this.dirty && !this.stopped) {
      this.dirty = false;
      await this.run();
    }
  }
}
