/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Logger } from '@nestjs/common';
import type { EventTransport, TransportHandlers } from './EventTransport';
import type { EventEnvelope, TransportState } from './types';

/** The subset of an ioredis client used here (lets tests provide a fake). */
export interface RedisLike {
  duplicate(): RedisSubscriberLike;
  publish(channel: string, message: string): Promise<number>;
}

export interface RedisSubscriberLike {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  quit(): Promise<unknown>;
  disconnect?(): void;
}

interface DownFlags {
  subscriberDown: boolean;
  publishDown: boolean;
}

const LOG_EVERY_MS = 30_000;

/**
 * Redis pub/sub transport (`PUBLISH <channel>`; the subscription uses its own `duplicate()`d connection because a
 * subscribed ioredis connection cannot issue other commands). Fail-open: a publish error or a lost subscriber
 * connection flips the state to `degraded` (reported to the service) and is logged at most every 30 s; the service
 * keeps delivering to its local connections regardless. ioredis reconnects and resubscribes by itself.
 */
export class RedisTransport implements EventTransport {
  readonly name = 'redis' as const;
  private readonly logger = new Logger(RedisTransport.name);
  private handlers: TransportHandlers | null = null;
  private subscriber: RedisSubscriberLike | null = null;
  private state: TransportState = 'ok';
  private down: DownFlags = { subscriberDown: false, publishDown: false };
  private lastLogAt = 0;

  constructor(
    private readonly client: RedisLike,
    private readonly channel: string,
  ) {}

  start(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  async listen(): Promise<void> {
    if (this.subscriber) return;
    try {
      const sub = this.client.duplicate();
      this.subscriber = sub;
      sub.on('message', (...args: unknown[]) => this.receive(String(args[1])));
      sub.on('ready', () => this.flag({ subscriberDown: false }));
      sub.on('error', (...args: unknown[]) => this.fail('subscriber error', args[0], { subscriberDown: true }));
      sub.on('close', () => this.fail('subscriber connection closed', undefined, { subscriberDown: true }));
      await sub.subscribe(this.channel);
    } catch (err) {
      this.fail('subscribe failed', err, { subscriberDown: true });
    }
  }

  async unlisten(): Promise<void> {
    const sub = this.subscriber;
    this.subscriber = null;
    this.flag({ subscriberDown: false });
    if (!sub) return;
    try {
      await sub.unsubscribe(this.channel);
      await sub.quit();
    } catch {
      sub.disconnect?.();
    }
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    try {
      await this.client.publish(this.channel, JSON.stringify(envelope));
      this.flag({ publishDown: false });
    } catch (err) {
      this.fail('publish failed', err, { publishDown: true });
    }
  }

  async stop(): Promise<void> {
    await this.unlisten();
    this.handlers = null;
  }

  private receive(message: string): void {
    try {
      const envelope = JSON.parse(message) as EventEnvelope;
      if (envelope?.event && envelope.audience && envelope.origin) this.handlers?.onEnvelope(envelope);
    } catch {
      this.logThrottled('ignored a malformed message');
    }
  }

  private fail(what: string, err: unknown, flags: Partial<DownFlags>): void {
    const detail = err instanceof Error ? `: ${err.message}` : '';
    this.logThrottled(`${what}${detail} — events from other processes may be missed`);
    this.flag(flags);
  }

  /** Degraded as long as either the subscriber connection or the publishing path is failing. */
  private flag(flags: Partial<DownFlags>): void {
    this.down = { ...this.down, ...flags };
    const state: TransportState = this.down.subscriberDown || this.down.publishDown ? 'degraded' : 'ok';
    if (state === this.state) return;
    this.state = state;
    this.logger.log(`transport state: ${state}`);
    this.handlers?.onState(state);
  }

  private logThrottled(message: string): void {
    const now = Date.now();
    if (now - this.lastLogAt < LOG_EVERY_MS) return;
    this.lastLogAt = now;
    this.logger.warn(message);
  }
}
