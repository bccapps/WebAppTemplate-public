/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export * from './types';
export * from './audience';
export { EventStreamService, type ConnectionSink } from './EventStreamService';
export { EventStreamController } from './EventStreamController';
export { EVENT_STREAM_OPTIONS, type EventStreamOptions } from './constants';
export type { EventTransport, TransportHandlers } from './EventTransport';
export { InMemoryTransport, InMemoryBus } from './InMemoryTransport';
export { RedisTransport, type RedisLike, type RedisSubscriberLike } from './RedisTransport';
