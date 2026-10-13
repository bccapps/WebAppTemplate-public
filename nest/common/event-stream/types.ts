/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { AuthPrincipal } from '../auth';

/** Who may receive an event. Every field that is present must match the connection principal. */
export interface EventAudience {
  /** The connection principal's `id` must equal this value. */
  userId?: number;
  /** The connection principal's `tenantId` property must equal this value (e.g. a company or workspace id). */
  tenantId?: string | number;
  /** Only administrators. */
  admin?: true;
  /** Every authenticated connection (still restricted to the topics it subscribed to). */
  public?: true;
}

/** JSON-serialisable payload; keep it small (progress, status): clients refetch details over REST. */
export type EventData = Record<string, unknown>;

/** What a publisher provides; the topic is a separate argument. */
export interface StreamEventInput {
  /** Event kind, e.g. `status`, `changed`, `metrics`. */
  type: string;
  /** Identifier of the resource concerned, if any. */
  id?: string | number;
  /** Monotonic version of the resource, so clients can drop stale events. */
  version?: number;
  data?: EventData;
}

/** The event as delivered to clients (`data:` field of the SSE frame). */
export interface StreamEvent extends StreamEventInput {
  topic: string;
}

/** Result of matching a concrete topic against a registered pattern (`ocr.document:*`). */
export interface TopicMatch {
  /** Concrete topic the client asked for. */
  topic: string;
  /** Text matched by the wildcard (`42` for `ocr.document:42`); empty for an exact pattern. */
  key: string;
}

/** Decides at subscription time whether a principal may follow a topic. Throwing counts as a refusal. */
export type TopicAuthorizer = (principal: AuthPrincipal, match: TopicMatch) => boolean | Promise<boolean>;

/** What a topic producer may return from `produce`. */
export type ProducedEvents = StreamEventInput | StreamEventInput[] | null | undefined | void;

export interface TopicProducer {
  /** Delay between two `produce` calls for one topic (the next call starts after the previous one ended). */
  intervalMs: number;
  /** Mandatory: producer events skip the audience filter, the subscription check is the only gate. */
  authorize: TopicAuthorizer;
  /** Called once when the first local subscriber arrives, then every `intervalMs`, until the last one leaves. */
  produce: (match: TopicMatch) => ProducedEvents | Promise<ProducedEvents>;
}

/** Message exchanged between processes by an `EventTransport`. */
export interface EventEnvelope {
  event: StreamEvent;
  audience: EventAudience;
  /** Instance id of the publisher: its own relay is ignored (it already delivered locally). */
  origin: string;
}

export type TransportState = 'ok' | 'degraded';

/** One frame written to a connection. */
export interface StreamFrame {
  /** SSE `event:` name: the topic events use their own `type`-less name `event`. */
  name: 'event' | 'ready' | 'transport' | 'resync' | 'expired';
  data: unknown;
  /** Present on relayed events only; becomes the SSE `id:` used by `Last-Event-ID`. */
  id?: string;
}

export interface OpenConnectionResult {
  /** Topics the connection follows. */
  topics: string[];
  /** Topics refused by an authorizer (reported in the `ready` frame). */
  denied: string[];
  /** Detaches the connection (unsubscribes, stops producers nobody listens to anymore). Idempotent. */
  close: () => void;
}
