/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { EventEnvelope, TransportState } from './types';

export interface TransportHandlers {
  /** An envelope arrived from the transport (possibly the publisher's own: the service filters it). */
  onEnvelope: (envelope: EventEnvelope) => void;
  /** The ability to receive other processes' events changed. */
  onState: (state: TransportState) => void;
}

/**
 * Carries envelopes between processes. The service always delivers to its own connections itself, so a transport
 * only has to reach the *other* processes. It must never throw from `publish` (fail-open).
 */
export interface EventTransport {
  readonly name: 'memory' | 'redis';
  start(handlers: TransportHandlers): void;
  /** Starts receiving (first local connection). */
  listen(): Promise<void>;
  /** Stops receiving (last local connection left). */
  unlisten(): Promise<void>;
  publish(envelope: EventEnvelope): Promise<void>;
  stop(): Promise<void>;
}
