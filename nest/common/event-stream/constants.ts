/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export const MAX_TOPICS_PER_CONNECTION = 50;
export const MAX_CONNECTIONS_PER_PRINCIPAL = 10;
export const MAX_EVENT_BYTES = 16 * 1024;
export const REPLAY_BUFFER_SIZE = 500;
export const HEARTBEAT_MS = 20_000;
/** Valid concrete topic: `<module>.<resource>[:<key>]`. No wildcard, no comma. */
export const TOPIC_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+(:[A-Za-z0-9_.:@-]+)?$/;

/** Optional overrides (tests, tuning); provide it with `{ provide: EVENT_STREAM_OPTIONS, useValue: {...} }`. */
export const EVENT_STREAM_OPTIONS = Symbol('EVENT_STREAM_OPTIONS');
export interface EventStreamOptions {
  heartbeatMs?: number;
  maxTopicsPerConnection?: number;
  maxConnectionsPerPrincipal?: number;
  maxEventBytes?: number;
  replayBufferSize?: number;
}
