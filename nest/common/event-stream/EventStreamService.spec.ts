/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException, HttpException } from '@nestjs/common';
import type { AuthPrincipal } from '../auth';
import type { RedisService } from '../services/RedisService';
import { EventStreamService, type ConnectionSink } from './EventStreamService';
import { InMemoryBus, InMemoryTransport } from './InMemoryTransport';
import type { EventTransport, TransportHandlers } from './EventTransport';
import type { EventStreamOptions } from './constants';
import type { EventEnvelope, StreamFrame } from './types';

const noRedis = { getClient: () => null } as unknown as RedisService;
const alice: AuthPrincipal = { id: 1, admin: false, kind: 'user', tenantId: 'c1' };
const bob: AuthPrincipal = { id: 2, admin: false, kind: 'user', tenantId: 'c2' };
const root: AuthPrincipal = { id: 0, admin: true, kind: 'admin-token' };

function makeSink(): ConnectionSink & { frames: StreamFrame[]; ended: boolean; events(): unknown[] } {
  const sink = {
    frames: [] as StreamFrame[],
    ended: false,
    send(frame: StreamFrame) {
      sink.frames.push(frame);
    },
    end() {
      sink.ended = true;
    },
    events: () => sink.frames.filter((f) => f.name === 'event').map((f) => f.data),
  };
  return sink;
}

function makeService(options?: EventStreamOptions, bus?: InMemoryBus): EventStreamService {
  const service = new EventStreamService(noRedis, options);
  service.useTransport(new InMemoryTransport(bus));
  return service;
}

const changed = { type: 'changed' };

describe('EventStreamService publishing', () => {
  let service: EventStreamService;
  beforeEach(() => {
    service = makeService();
  });
  afterEach(() => service.onModuleDestroy());

  it('delivers only to matching audiences and subscribed topics', async () => {
    const a = makeSink();
    const b = makeSink();
    const r = makeSink();
    await service.openConnection(alice, ['x.items', 'x.other'], a);
    await service.openConnection(bob, ['x.items'], b);
    await service.openConnection(root, ['x.items'], r);
    service.publish('x.items', changed, { userId: 1 });
    service.publish('x.items', { type: 'secret' }, { admin: true });
    service.publish('x.other', changed, { tenantId: 'c1' });
    service.publish('x.unfollowed', changed, { public: true });
    expect(a.events()).toEqual([
      { topic: 'x.items', type: 'changed' },
      { topic: 'x.other', type: 'changed' },
    ]);
    expect(b.events()).toEqual([]);
    expect(r.events()).toEqual([{ topic: 'x.items', type: 'secret' }]);
  });

  it('delivers nothing when the audience is empty', async () => {
    const a = makeSink();
    await service.openConnection(alice, ['x.items'], a);
    service.publish('x.items', changed, {});
    expect(a.events()).toEqual([]);
  });

  it('drops invalid topics, missing types and oversized events without throwing', async () => {
    const small = makeService({ maxEventBytes: 100 });
    const a = makeSink();
    await small.openConnection(alice, ['x.items'], a);
    small.publish('bad topic', changed, { public: true });
    small.publish('x.items', { type: '' }, { public: true });
    small.publish('x.items', { type: 'big', data: { text: 'x'.repeat(200) } }, { public: true });
    small.publish('x.items', changed, { public: true });
    expect(a.events()).toEqual([{ topic: 'x.items', type: 'changed' }]);
    await small.onModuleDestroy();
  });

  it('numbers relayed events for Last-Event-ID but not producer or control frames', async () => {
    const a = makeSink();
    await service.openConnection(alice, ['x.items'], a);
    service.publish('x.items', changed, { public: true });
    const ids = a.frames.map((f) => f.id);
    expect(ids[0]).toBeUndefined();
    expect(ids[1]).toBe(`${service.instanceId}.1`);
  });
});

describe('EventStreamService throttling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends the first call at once and then the last call of each interval', async () => {
    const service = makeService();
    const a = makeSink();
    await service.openConnection(alice, ['x.metrics'], a);
    const pub = (n: number) => service.publishThrottled('run1', 1000, 'x.metrics', { type: 'm', version: n }, { public: true });
    pub(1);
    pub(2);
    pub(3);
    expect(a.events()).toHaveLength(1);
    jest.advanceTimersByTime(999);
    expect(a.events()).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(a.events().map((e) => (e as { version: number }).version)).toEqual([1, 3]);
    jest.advanceTimersByTime(5000);
    pub(4);
    expect(a.events()).toHaveLength(3);
    await service.onModuleDestroy();
  });

  it('throttles keys independently', async () => {
    const service = makeService();
    const a = makeSink();
    await service.openConnection(alice, ['x.metrics'], a);
    service.publishThrottled('k1', 1000, 'x.metrics', changed, { public: true });
    service.publishThrottled('k2', 1000, 'x.metrics', changed, { public: true });
    expect(a.events()).toHaveLength(2);
    await service.onModuleDestroy();
  });
});

describe('EventStreamService authorization and limits', () => {
  let service: EventStreamService;
  beforeEach(() => {
    service = makeService({ maxTopicsPerConnection: 3, maxConnectionsPerPrincipal: 2 });
  });
  afterEach(() => service.onModuleDestroy());

  it('refuses unauthorized topics, reports them, and 403s when none is left', async () => {
    service.registerTopicAuthorizer('x.run:*', (p, m) => p.id === 1 && m.key === '5');
    const a = makeSink();
    const open = await service.openConnection(alice, ['x.run:5', 'x.run:6', 'x.plain'], a);
    expect(open.topics).toEqual(['x.run:5', 'x.plain']);
    expect(open.denied).toEqual(['x.run:6']);
    expect(a.frames[0]).toEqual({ name: 'ready', data: { topics: ['x.run:5', 'x.plain'], denied: ['x.run:6'], transport: 'ok' } });
    await expect(service.openConnection(bob, ['x.run:5'], makeSink())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('treats a throwing authorizer as a refusal and supports unregistering', async () => {
    const off = service.registerTopicAuthorizer('x.boom', () => {
      throw new Error('db down');
    });
    await expect(service.openConnection(alice, ['x.boom'], makeSink())).rejects.toBeInstanceOf(ForbiddenException);
    off();
    await expect(service.openConnection(alice, ['x.boom'], makeSink())).resolves.toBeDefined();
  });

  it('rejects empty, invalid and too many topics', async () => {
    await expect(service.openConnection(alice, ['', ' '], makeSink())).rejects.toMatchObject({ status: 400 });
    await expect(service.openConnection(alice, ['x.*'], makeSink())).rejects.toMatchObject({ status: 400 });
    await expect(service.openConnection(alice, ['a.1', 'a.2', 'a.3', 'a.4'], makeSink())).rejects.toMatchObject({ status: 400 });
  });

  it('limits connections per principal and frees the slot on close', async () => {
    const first = await service.openConnection(alice, ['x.a'], makeSink());
    await service.openConnection(alice, ['x.a'], makeSink());
    await expect(service.openConnection(alice, ['x.a'], makeSink())).rejects.toBeInstanceOf(HttpException);
    await expect(service.openConnection(alice, ['x.a'], makeSink())).rejects.toMatchObject({ status: 429 });
    await expect(service.openConnection(bob, ['x.a'], makeSink())).resolves.toBeDefined();
    first.close();
    await expect(service.openConnection(alice, ['x.a'], makeSink())).resolves.toBeDefined();
  });

  it('stops delivering after close', async () => {
    const a = makeSink();
    const open = await service.openConnection(alice, ['x.a'], a);
    open.close();
    open.close();
    service.publish('x.a', changed, { public: true });
    expect(a.events()).toEqual([]);
  });
});

describe('EventStreamService producers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs per topic while subscribers exist, shared between connections, and stops with the last one', async () => {
    const service = makeService();
    const produce = jest.fn(async () => ({ type: 'tick' }));
    service.registerTopicProducer('x.candle:*', { intervalMs: 1000, authorize: () => true, produce });
    const a = makeSink();
    const b = makeSink();
    const first = await service.openConnection(alice, ['x.candle:btc'], a);
    const second = await service.openConnection(bob, ['x.candle:btc'], b);
    await jest.advanceTimersByTimeAsync(2500);
    expect(produce).toHaveBeenCalledTimes(3);
    expect(produce).toHaveBeenCalledWith({ topic: 'x.candle:btc', key: 'btc' });
    expect(a.events()).toHaveLength(3);
    expect(b.events()).toHaveLength(2); // joined after the first tick
    first.close();
    await jest.advanceTimersByTimeAsync(1000);
    expect(produce).toHaveBeenCalledTimes(4);
    second.close();
    await jest.advanceTimersByTimeAsync(5000);
    expect(produce).toHaveBeenCalledTimes(4);
    await service.openConnection(alice, ['x.candle:eth'], makeSink());
    await jest.advanceTimersByTimeAsync(0);
    expect(produce).toHaveBeenCalledTimes(5);
    await service.onModuleDestroy();
  });

  it('uses the producer authorizer, survives a failing produce and accepts arrays', async () => {
    const service = makeService();
    let calls = 0;
    service.registerTopicProducer('x.pos:*', {
      intervalMs: 1000,
      authorize: (p) => p.id === 1,
      produce: async () => {
        if (++calls === 1) throw new Error('platform down');
        return [{ type: 'a' }, { type: 'b' }];
      },
    });
    await expect(service.openConnection(bob, ['x.pos:1'], makeSink())).rejects.toBeInstanceOf(ForbiddenException);
    const a = makeSink();
    await service.openConnection(alice, ['x.pos:1'], a);
    await jest.advanceTimersByTimeAsync(1000);
    expect(a.events()).toEqual([
      { topic: 'x.pos:1', type: 'a' },
      { topic: 'x.pos:1', type: 'b' },
    ]);
    await service.onModuleDestroy();
  });

  it('starts for subscribers already present when the producer is registered, and stops on unregister', async () => {
    const service = makeService();
    const produce = jest.fn(async () => null);
    service.registerTopicAuthorizer('x.late:*', () => true);
    await service.openConnection(alice, ['x.late:1'], makeSink());
    const off = service.registerTopicProducer('x.late:*', { intervalMs: 1000, authorize: () => true, produce });
    await jest.advanceTimersByTimeAsync(0);
    expect(produce).toHaveBeenCalledTimes(1);
    off();
    await jest.advanceTimersByTimeAsync(5000);
    expect(produce).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });
});

describe('EventStreamService transports', () => {
  it('relays between instances sharing a bus, with their own audience filtering, without echo', async () => {
    const bus = new InMemoryBus();
    const api = makeService({}, bus);
    const worker = makeService({}, bus);
    const a = makeSink();
    await api.openConnection(alice, ['x.runs'], a);
    worker.publish('x.runs', changed, { userId: 1 });
    worker.publish('x.runs', { type: 'other' }, { userId: 2 });
    expect(a.events()).toEqual([{ topic: 'x.runs', type: 'changed' }]);
    api.publish('x.runs', { type: 'local' }, { userId: 1 });
    expect(a.events()).toHaveLength(2);
    await api.onModuleDestroy();
    await worker.onModuleDestroy();
  });

  it('listens only while a local connection exists (a publisher-only worker does not subscribe)', async () => {
    const calls: string[] = [];
    const spy: EventTransport = {
      name: 'memory',
      start: () => undefined,
      listen: async () => void calls.push('listen'),
      unlisten: async () => void calls.push('unlisten'),
      publish: async () => void calls.push('publish'),
      stop: async () => undefined,
    };
    const service = new EventStreamService(noRedis);
    service.useTransport(spy);
    service.publish('x.a', changed, { public: true });
    expect(calls).toEqual(['publish']);
    const open = await service.openConnection(alice, ['x.a'], makeSink());
    open.close();
    expect(calls).toEqual(['publish', 'listen', 'unlisten']);
  });

  it('broadcasts transport state changes to local connections and reports it to new ones', async () => {
    let handlers: TransportHandlers | undefined;
    const fake: EventTransport = {
      name: 'redis',
      start: (h) => void (handlers = h),
      listen: async () => undefined,
      unlisten: async () => undefined,
      publish: async () => undefined,
      stop: async () => undefined,
    };
    const service = new EventStreamService(noRedis);
    service.useTransport(fake);
    const a = makeSink();
    await service.openConnection(alice, ['x.a'], a);
    handlers?.onState('degraded');
    expect(service.currentTransportState).toBe('degraded');
    const late = makeSink();
    await service.openConnection(bob, ['x.a'], late);
    expect(late.frames[0].data).toMatchObject({ transport: 'degraded' });
    handlers?.onState('ok');
    expect(a.frames.filter((f) => f.name === 'transport').map((f) => f.data)).toEqual([{ state: 'degraded' }, { state: 'ok' }]);
  });

  it('ignores its own echo and malformed envelopes from the transport', async () => {
    let handlers: TransportHandlers | undefined;
    const fake: EventTransport = {
      name: 'redis',
      start: (h) => void (handlers = h),
      listen: async () => undefined,
      unlisten: async () => undefined,
      publish: async () => undefined,
      stop: async () => undefined,
    };
    const service = new EventStreamService(noRedis);
    service.useTransport(fake);
    const a = makeSink();
    await service.openConnection(alice, ['x.a'], a);
    const base: EventEnvelope = { event: { topic: 'x.a', type: 't' }, audience: { public: true }, origin: 'remote' };
    handlers?.onEnvelope({ ...base, origin: service.instanceId });
    handlers?.onEnvelope({ ...base, event: { topic: 'bad topic', type: 't' } });
    handlers?.onEnvelope({ ...base, audience: {} });
    handlers?.onEnvelope(base);
    expect(a.events()).toEqual([{ topic: 'x.a', type: 't' }]);
  });

  it('ends open connections on shutdown', async () => {
    const service = makeService();
    const a = makeSink();
    await service.openConnection(alice, ['x.a'], a);
    await service.onModuleDestroy();
    expect(a.ended).toBe(true);
  });
});

describe('EventStreamService Last-Event-ID', () => {
  it('replays missed events of the connection, filtered by topic and audience', async () => {
    const service = makeService();
    service.publish('x.a', { type: 'one' }, { public: true });
    service.publish('x.a', { type: 'mine' }, { userId: 2 });
    service.publish('x.b', { type: 'elsewhere' }, { public: true });
    service.publish('x.a', { type: 'two' }, { public: true });
    const a = makeSink();
    await service.openConnection(alice, ['x.a'], a, `${service.instanceId}.1`);
    expect(a.events()).toEqual([{ topic: 'x.a', type: 'two' }]);
    expect(a.frames.some((f) => f.name === 'resync')).toBe(false);
  });

  it('asks for a resync for a foreign instance, a gap, or a garbage id', async () => {
    const service = makeService({ replayBufferSize: 2 });
    for (let i = 0; i < 5; i++) service.publish('x.a', changed, { public: true });
    for (const id of ['other.1', `${service.instanceId}.1`, 'garbage', `${service.instanceId}.99`]) {
      const sink = makeSink();
      await service.openConnection(alice, ['x.a'], sink, id);
      expect(sink.frames.map((f) => f.name)).toEqual(['ready', 'resync']);
    }
    const ok = makeSink();
    await service.openConnection(alice, ['x.a'], ok, `${service.instanceId}.3`);
    expect(ok.events()).toHaveLength(2);
  });
});
