/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { AuthPrincipal } from '../auth';
import { RedisService } from '../services/RedisService';
import { hasAudience, matchesAudience, compileTopicPattern } from './audience';
import {
  EVENT_STREAM_OPTIONS,
  MAX_PENDING_BYTES,
  HEARTBEAT_MS,
  MAX_CONNECTIONS_PER_PRINCIPAL,
  MAX_EVENT_BYTES,
  MAX_TOPICS_PER_CONNECTION,
  REPLAY_BUFFER_SIZE,
  TOPIC_PATTERN,
  type EventStreamOptions,
} from './constants';
import type { EventTransport } from './EventTransport';
import { InMemoryTransport } from './InMemoryTransport';
import { RedisTransport, type RedisLike } from './RedisTransport';
import { ReplayBuffer } from './ReplayBuffer';
import { TopicProducerRunner } from './TopicProducerRunner';
import type {
  EventAudience,
  EventEnvelope,
  OpenConnectionResult,
  StreamEvent,
  StreamEventInput,
  StreamFrame,
  TopicAuthorizer,
  TopicMatch,
  TopicProducer,
  TransportState,
} from './types';

/** Where a connection receives its frames; `end` is called when the server shuts down. */
export interface ConnectionSink {
  send(frame: StreamFrame): void;
  end(): void;
}

const THROTTLE_PRUNE_THRESHOLD = 1000;
const THROTTLE_IDLE_MS = 60_000;

interface Connection {
  principal: AuthPrincipal;
  principalKey: string;
  topics: Set<string>;
  sink: ConnectionSink;
}

interface Registered<T> {
  pattern: string;
  match: (topic: string) => TopicMatch | null;
  value: T;
}

interface ThrottleSlot {
  lastSentAt: number;
  pending: (() => void) | null;
  timer: NodeJS.Timeout | null;
}

/**
 * Server-sent events hub. Publish from anywhere (services, schedulers, workers):
 *
 *     events.publish('ocr.document:12', { type: 'status', id: 5, data: { ocrStatus: 'completed' } }, { userId: 3 });
 *
 * An event with an empty audience is delivered to nobody (no implicit broadcast). See `nest/common/README.md`.
 */
@Injectable()
export class EventStreamService implements OnModuleInit, OnModuleDestroy {
  /** Identifies this process: its own transport echoes are ignored and replay ids are scoped to it. */
  readonly instanceId = randomUUID().slice(0, 8);
  private readonly logger = new Logger(EventStreamService.name);
  private readonly limits: Required<EventStreamOptions>;
  private readonly connections = new Set<Connection>();
  private readonly topicRefs = new Map<string, number>();
  private readonly authorizers: Registered<TopicAuthorizer>[] = [];
  private readonly producers: Registered<TopicProducer>[] = [];
  private readonly throttles = new Map<string, ThrottleSlot>();
  private readonly runner = new TopicProducerRunner((topic, event) => this.deliverToTopic(topic, event));
  private readonly replay: ReplayBuffer;
  private transport: EventTransport = new InMemoryTransport();
  private transportState: TransportState = 'ok';

  constructor(
    private readonly redis: RedisService,
    @Optional() @Inject(EVENT_STREAM_OPTIONS) options?: EventStreamOptions,
  ) {
    this.limits = {
      heartbeatMs: options?.heartbeatMs ?? HEARTBEAT_MS,
      maxTopicsPerConnection: options?.maxTopicsPerConnection ?? MAX_TOPICS_PER_CONNECTION,
      maxConnectionsPerPrincipal: options?.maxConnectionsPerPrincipal ?? MAX_CONNECTIONS_PER_PRINCIPAL,
      maxEventBytes: options?.maxEventBytes ?? MAX_EVENT_BYTES,
      replayBufferSize: options?.replayBufferSize ?? REPLAY_BUFFER_SIZE,
      maxPendingBytes: options?.maxPendingBytes ?? MAX_PENDING_BYTES,
    };
    this.replay = new ReplayBuffer(this.instanceId, this.limits.replayBufferSize);
  }

  onModuleInit(): void {
    const client = this.redis.getClient();
    const channel = `${process.env.PROJECT_NAME ?? 'UnknownApp'}:SSE`;
    this.useTransport(client ? new RedisTransport(client as unknown as RedisLike, channel) : new InMemoryTransport());
  }

  async onModuleDestroy(): Promise<void> {
    this.runner.stopAll();
    for (const slot of this.throttles.values()) if (slot.timer) clearTimeout(slot.timer);
    this.throttles.clear();
    for (const connection of [...this.connections]) connection.sink.end();
    this.connections.clear();
    await this.transport.stop();
  }

  /** Replaces the transport (module init, tests). The previous one is stopped. */
  useTransport(transport: EventTransport): void {
    void this.transport.stop();
    this.transport = transport;
    this.transportState = 'ok';
    transport.start({
      onEnvelope: (envelope) => this.onTransportEnvelope(envelope),
      onState: (state) => this.onTransportState(state),
    });
    if (this.connections.size > 0) void transport.listen();
    this.logger.log(`event transport: ${transport.name}`);
  }

  get heartbeatMs(): number {
    return this.limits.heartbeatMs;
  }

  /** Number of open connections on this process (monitoring, tests). */
  get connectionCount(): number {
    return this.connections.size;
  }

  get maxPendingBytes(): number {
    return this.limits.maxPendingBytes;
  }

  get currentTransportState(): TransportState {
    return this.transportState;
  }

  // ───────────────────────────── publishing ─────────────────────────────

  /** Fire-and-forget; never throws. Invalid topic, oversized event or empty audience: logged and dropped. */
  publish(topic: string, event: StreamEventInput, audience: EventAudience): void {
    const envelope = this.buildEnvelope(topic, event, audience);
    if (!envelope) return;
    this.relay(envelope);
    void this.transport.publish(envelope).catch(() => undefined);
  }

  /** At most one event per `key` every `intervalMs`; while waiting, the latest call replaces the pending one. */
  publishThrottled(key: string, intervalMs: number, topic: string, event: StreamEventInput, audience: EventAudience): void {
    this.pruneThrottles();
    const slot = this.throttles.get(key) ?? { lastSentAt: 0, pending: null, timer: null };
    this.throttles.set(key, slot);
    const send = (): void => {
      slot.lastSentAt = Date.now();
      slot.pending = null;
      slot.timer = null;
      this.publish(topic, event, audience);
    };
    const wait = slot.lastSentAt + intervalMs - Date.now();
    if (wait <= 0 && !slot.timer) return send();
    slot.pending = send;
    if (slot.timer) return;
    slot.timer = setTimeout(() => slot.pending?.(), Math.max(wait, 0));
    slot.timer.unref();
  }

  /** Keys are often per-resource ids: forget idle slots so the map cannot grow without bound. */
  private pruneThrottles(): void {
    if (this.throttles.size < THROTTLE_PRUNE_THRESHOLD) return;
    const cutoff = Date.now() - THROTTLE_IDLE_MS;
    for (const [key, slot] of this.throttles) {
      if (!slot.timer && slot.lastSentAt < cutoff) this.throttles.delete(key);
    }
  }

  // ───────────────────────────── registration ─────────────────────────────

  /** `pattern` is an exact topic or ends with `*` (e.g. `ocr.document:*`). Returns an unregister function. */
  registerTopicAuthorizer(pattern: string, authorize: TopicAuthorizer): () => void {
    const entry = { pattern, match: compileTopicPattern(pattern), value: authorize };
    this.authorizers.push(entry);
    return () => {
      const index = this.authorizers.indexOf(entry);
      if (index >= 0) this.authorizers.splice(index, 1);
    };
  }

  /**
   * Starts `produce` on this process while at least one local connection follows a matching topic, and stops it
   * when the last one leaves. A second registration of the same pattern replaces the first.
   */
  registerTopicProducer(pattern: string, producer: TopicProducer): () => void {
    const existing = this.producers.findIndex((p) => p.pattern === pattern);
    if (existing >= 0) this.removeProducer(this.producers[existing]);
    const entry = { pattern, match: compileTopicPattern(pattern), value: producer };
    this.producers.push(entry);
    for (const topic of this.topicRefs.keys()) {
      const match = entry.match(topic);
      if (match) this.runner.start(match, producer);
    }
    return () => this.removeProducer(entry);
  }

  // ───────────────────────────── connections ─────────────────────────────

  /**
   * Validates the request, applies limits and authorization, registers the connection, then sends the `ready` frame
   * (plus replayed events or `resync` when `lastEventId` is given). Throws an `HttpException` when refused.
   */
  async openConnection(
    principal: AuthPrincipal,
    requested: string[],
    sink: ConnectionSink,
    lastEventId?: string,
  ): Promise<OpenConnectionResult> {
    const topics = this.validateRequest(principal, requested);
    const { allowed, denied } = await this.authorizeAll(principal, topics);
    if (allowed.length === 0) {
      this.logger.warn(`subscription refused for principal ${principal.kind}:${principal.id}: ${denied.join(', ')}`);
      throw new ForbiddenException('No requested topic is authorized');
    }
    const connection: Connection = {
      principal,
      principalKey: `${principal.kind}:${principal.id}`,
      topics: new Set(allowed),
      sink,
    };
    this.attach(connection);
    sink.send({ name: 'ready', data: { topics: allowed, denied, transport: this.transportState } });
    if (lastEventId) this.replayTo(connection, lastEventId);
    return { topics: allowed, denied, close: () => this.detach(connection) };
  }

  // ───────────────────────────── internals ─────────────────────────────

  private buildEnvelope(topic: string, event: StreamEventInput, audience: EventAudience): EventEnvelope | null {
    if (!TOPIC_PATTERN.test(topic)) {
      this.logger.warn(`event dropped: invalid topic "${topic}"`);
    } else if (!hasAudience(audience)) {
      this.logger.warn(`event dropped: no audience for ${topic} (no implicit broadcast)`);
    } else if (!event?.type) {
      this.logger.warn(`event dropped: missing type for ${topic}`);
    } else {
      const full: StreamEvent = { topic, ...event };
      if (Buffer.byteLength(JSON.stringify(full)) <= this.limits.maxEventBytes) {
        return { event: full, audience, origin: this.instanceId };
      }
      this.logger.warn(`event dropped: larger than ${this.limits.maxEventBytes} bytes (${topic})`);
    }
    return null;
  }

  private relay(envelope: EventEnvelope): void {
    const { seq } = this.replay.push(envelope);
    const frame: StreamFrame = { name: 'event', data: envelope.event, id: this.replay.idOf(seq) };
    for (const connection of this.connections) {
      if (this.isRecipient(connection, envelope)) connection.sink.send(frame);
    }
  }

  private isRecipient(connection: Connection, envelope: EventEnvelope): boolean {
    return connection.topics.has(envelope.event.topic) && matchesAudience(envelope.audience, connection.principal);
  }

  private deliverToTopic(topic: string, event: StreamEventInput): void {
    const frame: StreamFrame = { name: 'event', data: { topic, ...event } };
    for (const connection of this.connections) if (connection.topics.has(topic)) connection.sink.send(frame);
  }

  private onTransportEnvelope(envelope: EventEnvelope): void {
    if (envelope.origin === this.instanceId || !TOPIC_PATTERN.test(envelope.event.topic)) return;
    if (!hasAudience(envelope.audience)) return;
    this.relay(envelope);
  }

  private onTransportState(state: TransportState): void {
    this.transportState = state;
    for (const connection of this.connections) connection.sink.send({ name: 'transport', data: { state } });
  }

  private validateRequest(principal: AuthPrincipal, requested: string[]): string[] {
    const topics = [...new Set(requested.map((t) => t.trim()).filter(Boolean))];
    if (topics.length === 0) throw new BadRequestException('At least one topic is required');
    if (topics.length > this.limits.maxTopicsPerConnection) {
      this.logger.warn(`too many topics (${topics.length}) from ${principal.kind}:${principal.id}`);
      throw new BadRequestException(`At most ${this.limits.maxTopicsPerConnection} topics per connection`);
    }
    const invalid = topics.find((t) => !TOPIC_PATTERN.test(t));
    if (invalid) throw new BadRequestException(`Invalid topic: ${invalid}`);
    const key = `${principal.kind}:${principal.id}`;
    const open = [...this.connections].filter((c) => c.principalKey === key).length;
    if (open >= this.limits.maxConnectionsPerPrincipal) {
      this.logger.warn(`too many connections for ${key} (${open})`);
      throw new HttpException('Too many event streams for this user', HttpStatus.TOO_MANY_REQUESTS);
    }
    return topics;
  }

  private async authorizeAll(principal: AuthPrincipal, topics: string[]): Promise<{ allowed: string[]; denied: string[] }> {
    const verdicts = await Promise.all(topics.map((topic) => this.isAuthorized(principal, topic)));
    return {
      allowed: topics.filter((_, i) => verdicts[i]),
      denied: topics.filter((_, i) => !verdicts[i]),
    };
  }

  private async isAuthorized(principal: AuthPrincipal, topic: string): Promise<boolean> {
    const checks: Array<[TopicAuthorizer, TopicMatch]> = [];
    for (const a of this.authorizers) {
      const match = a.match(topic);
      if (match) checks.push([a.value, match]);
    }
    const producer = this.findProducer(topic);
    if (producer) checks.push([producer.producer.authorize, producer.match]);
    for (const [authorize, match] of checks) {
      try {
        if (!(await authorize(principal, match))) return false;
      } catch (err) {
        this.logger.warn(`authorizer failed for ${topic}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }
    return true;
  }

  private findProducer(topic: string): { producer: TopicProducer; match: TopicMatch } | null {
    for (const p of this.producers) {
      const match = p.match(topic);
      if (match) return { producer: p.value, match };
    }
    return null;
  }

  private attach(connection: Connection): void {
    this.connections.add(connection);
    if (this.connections.size === 1) void this.transport.listen();
    for (const topic of connection.topics) {
      const refs = (this.topicRefs.get(topic) ?? 0) + 1;
      this.topicRefs.set(topic, refs);
      const found = refs === 1 ? this.findProducer(topic) : null;
      if (found) this.runner.start(found.match, found.producer);
    }
  }

  private detach(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    for (const topic of connection.topics) {
      const refs = (this.topicRefs.get(topic) ?? 1) - 1;
      if (refs > 0) {
        this.topicRefs.set(topic, refs);
      } else {
        this.topicRefs.delete(topic);
        this.runner.stop(topic);
      }
    }
    if (this.connections.size === 0) void this.transport.unlisten();
  }

  private replayTo(connection: Connection, lastEventId: string): void {
    const window = this.replay.since(lastEventId);
    if (window.kind === 'resync') {
      connection.sink.send({ name: 'resync', data: {} });
      return;
    }
    for (const { seq, envelope } of window.events) {
      if (this.isRecipient(connection, envelope)) {
        connection.sink.send({ name: 'event', data: envelope.event, id: this.replay.idOf(seq) });
      }
    }
  }

  private removeProducer(entry: Registered<TopicProducer>): void {
    const index = this.producers.indexOf(entry);
    if (index < 0) return;
    this.producers.splice(index, 1);
    for (const topic of this.topicRefs.keys()) if (entry.match(topic)) this.runner.stop(topic);
  }
}
