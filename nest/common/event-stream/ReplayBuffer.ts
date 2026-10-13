/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { EventEnvelope } from './types';

export interface BufferedEnvelope {
  seq: number;
  envelope: EventEnvelope;
}

export type ReplayWindow = { kind: 'events'; events: BufferedEnvelope[] } | { kind: 'resync' };

/**
 * Circular buffer of the latest relayed envelopes, for best-effort `Last-Event-ID` resumption. Ids look like
 * `<instance>.<seq>`: a client that reconnects to another instance, or after a gap larger than the buffer, gets a
 * `resync` and refetches everything.
 */
export class ReplayBuffer {
  private readonly items: BufferedEnvelope[] = [];
  private seq = 0;

  constructor(
    private readonly instanceId: string,
    private readonly capacity: number,
  ) {}

  push(envelope: EventEnvelope): BufferedEnvelope {
    const item = { seq: ++this.seq, envelope };
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
    return item;
  }

  idOf(seq: number): string {
    return `${this.instanceId}.${seq}`;
  }

  since(lastEventId: string): ReplayWindow {
    const [instance, rawSeq] = lastEventId.split('.');
    const last = Number(rawSeq);
    if (instance !== this.instanceId || !Number.isInteger(last) || last < 0 || last > this.seq) {
      return { kind: 'resync' };
    }
    if (last === this.seq) return { kind: 'events', events: [] };
    const oldest = this.items[0]?.seq ?? this.seq + 1;
    if (last + 1 < oldest) return { kind: 'resync' };
    return { kind: 'events', events: this.items.filter((item) => item.seq > last) };
  }
}
