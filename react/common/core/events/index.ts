/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export { EventStreamClient, type EventStreamDeps } from './EventStreamClient';
export { eventStreamClient, sessionIdentity } from './eventStream';
export { SseParser, readSse, type SseMessage } from './sseParser';
export { computeBackoff } from './backoff';
export { LiveResourceController, type LiveResourceControllerOptions } from './liveResourceController';
export { useServerEvents } from './useServerEvents';
export { useLiveResource, type LiveResource, type UseLiveResourceOptions } from './useLiveResource';
export type { ServerEvent, ServerEventHandler, StreamState, SubscribeOptions } from './types';
