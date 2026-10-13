/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { EventTransport, TransportHandlers } from './EventTransport';
import type { EventEnvelope } from './types';

/**
 * In-process bus: the default without `REDIS_URL` and the fallback when Redis is unusable. Several instances created
 * from the same `InMemoryBus` see each other, which lets tests simulate a multi-instance deployment.
 */
export class InMemoryBus {
  readonly listeners = new Set<(envelope: EventEnvelope) => void>();
}

export class InMemoryTransport implements EventTransport {
  readonly name = 'memory' as const;
  private handlers: TransportHandlers | null = null;
  private listening = false;
  private readonly receive = (envelope: EventEnvelope): void => this.handlers?.onEnvelope(envelope);

  constructor(private readonly bus: InMemoryBus = new InMemoryBus()) {}

  start(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  async listen(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    this.bus.listeners.add(this.receive);
  }

  async unlisten(): Promise<void> {
    this.listening = false;
    this.bus.listeners.delete(this.receive);
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    for (const listener of [...this.bus.listeners]) listener(envelope);
  }

  async stop(): Promise<void> {
    await this.unlisten();
    this.handlers = null;
  }
}
