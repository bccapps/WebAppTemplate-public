/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Event as delivered by the server (`data:` of an SSE `event` frame); mirrors `nest/common/event-stream/types.ts`. */
export interface ServerEvent {
  topic: string;
  type: string;
  id?: string | number;
  version?: number;
  data?: Record<string, unknown>;
}

/**
 * `connecting`: no live stream yet (or none wanted). `open`: stream established, events are pushed.
 * `fallback`: pushing is unavailable (3 failures, module absent, or degraded server transport): callers poll.
 */
export type StreamState = 'connecting' | 'open' | 'fallback';

export type ServerEventHandler = (event: ServerEvent) => void;

export interface SubscribeOptions {
  /** Called when the server asks to reload everything (replay impossible after a reconnection). */
  onResync?: () => void;
}
