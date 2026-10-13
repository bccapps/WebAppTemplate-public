/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { RedisTransport, type RedisLike, type RedisSubscriberLike } from './RedisTransport';
import type { EventEnvelope, TransportState } from './types';

type Listener = (...args: unknown[]) => void;

class FakeSubscriber implements RedisSubscriberLike {
  readonly listeners = new Map<string, Listener[]>();
  subscribed: string[] = [];
  quit = jest.fn(async () => 'OK');
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  async subscribe(channel: string): Promise<number> {
    this.subscribed.push(channel);
    return 1;
  }
  async unsubscribe(channel: string): Promise<number> {
    this.subscribed = this.subscribed.filter((c) => c !== channel);
    return 0;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

class FakeClient implements RedisLike {
  readonly sub = new FakeSubscriber();
  duplicates = 0;
  published: Array<[string, string]> = [];
  failPublish = false;
  duplicate(): FakeSubscriber {
    this.duplicates++;
    return this.sub;
  }
  async publish(channel: string, message: string): Promise<number> {
    if (this.failPublish) throw new Error('connection refused');
    this.published.push([channel, message]);
    return 1;
  }
}

const envelope: EventEnvelope = {
  event: { topic: 'a.b', type: 'changed' },
  audience: { public: true },
  origin: 'other',
};

function setup() {
  const client = new FakeClient();
  const received: EventEnvelope[] = [];
  const states: TransportState[] = [];
  const transport = new RedisTransport(client, 'APP:SSE');
  transport.start({ onEnvelope: (e) => received.push(e), onState: (s) => states.push(s) });
  return { client, transport, received, states };
}

describe('RedisTransport', () => {
  it('subscribes on a duplicated client, on the prefixed channel', async () => {
    const { client, transport } = setup();
    await transport.listen();
    await transport.listen();
    expect(client.duplicates).toBe(1);
    expect(client.sub.subscribed).toEqual(['APP:SSE']);
  });

  it('publishes JSON on the channel and receives envelopes', async () => {
    const { client, transport, received } = setup();
    await transport.listen();
    await transport.publish(envelope);
    expect(client.published).toEqual([['APP:SSE', JSON.stringify(envelope)]]);
    client.sub.emit('message', 'APP:SSE', JSON.stringify(envelope));
    client.sub.emit('message', 'APP:SSE', 'not json');
    client.sub.emit('message', 'APP:SSE', JSON.stringify({ nope: true }));
    expect(received).toEqual([envelope]);
  });

  it('goes degraded when the subscriber connection drops, then ok when it is ready again', async () => {
    const { client, transport, states } = setup();
    await transport.listen();
    client.sub.emit('error', new Error('ECONNREFUSED'));
    client.sub.emit('close');
    client.sub.emit('ready');
    expect(states).toEqual(['degraded', 'ok']);
  });

  it('goes degraded on a failed publish without throwing, and recovers on the next success', async () => {
    const { client, transport, states } = setup();
    client.failPublish = true;
    await expect(transport.publish(envelope)).resolves.toBeUndefined();
    client.failPublish = false;
    await transport.publish(envelope);
    expect(states).toEqual(['degraded', 'ok']);
  });

  it('stays degraded while the subscriber is down even if publishing works', async () => {
    const { client, transport, states } = setup();
    await transport.listen();
    client.sub.emit('close');
    await transport.publish(envelope);
    expect(states).toEqual(['degraded']);
  });

  it('unsubscribes and quits on unlisten', async () => {
    const { client, transport } = setup();
    await transport.listen();
    await transport.unlisten();
    expect(client.sub.subscribed).toEqual([]);
    expect(client.sub.quit).toHaveBeenCalled();
  });
});
