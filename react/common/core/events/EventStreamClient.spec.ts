/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventStreamClient, SUBSCRIPTION_GROUP_MS, type EventStreamDeps } from './EventStreamClient';
import type { ServerEvent } from './types';

interface FakeConnection {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  send(text: string): void;
  close(): void;
}

function frame(event: string, data: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function setup(failWith?: () => Error | null) {
  const connections: FakeConnection[] = [];
  let sessionListener: (identity: string | null) => void = () => undefined;
  let refreshListener: () => void = () => undefined;
  const deps: EventStreamDeps = {
    streamGet: async (url, options) => {
      const error = failWith?.();
      if (error) throw error;
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
      options.signal.addEventListener('abort', () => {
        try {
          controller.error(new Error('aborted'));
        } catch {
          // already closed
        }
      });
      connections.push({
        url,
        headers: options.headers,
        signal: options.signal,
        send: (text) => controller.enqueue(encoder.encode(text)),
        close: () => controller.close(),
      });
      return stream;
    },
    baseUrl: () => '/api/v1',
    random: () => 0.5,
    watchSession: (l) => {
      sessionListener = l;
      return () => undefined;
    },
    watchTokenRefresh: (l) => {
      refreshListener = l;
      return () => undefined;
    },
  };
  const client = new EventStreamClient(deps);
  return {
    client,
    connections,
    signIn: (id: string | null) => sessionListener(id),
    tokenRefreshed: () => refreshListener(),
  };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const last = <T>(arr: T[]) => arr[arr.length - 1];

describe('EventStreamClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('groups subscriptions made within 50 ms into one connection', async () => {
    const { client, connections } = setup();
    client.subscribe(['b.x', 'a.y:1'], () => undefined);
    client.subscribe(['a.z'], () => undefined);
    await tick(SUBSCRIPTION_GROUP_MS - 1);
    expect(connections).toHaveLength(0);
    await tick(1);
    expect(connections).toHaveLength(1);
    expect(connections[0].url).toBe('/api/v1/events/stream?topics=a.y:1,a.z,b.x');
  });

  it('counts references per topic and reopens only when the set changes', async () => {
    const { client, connections } = setup();
    const off1 = client.subscribe(['a.x'], () => undefined);
    const off2 = client.subscribe(['a.x'], () => undefined);
    await tick(60);
    expect(client.getTopicRefCount('a.x')).toBe(2);
    off1();
    await tick(60);
    expect(connections).toHaveLength(1);
    expect(connections[0].signal.aborted).toBe(false);
    const off3 = client.subscribe(['b.y'], () => undefined);
    await tick(60);
    expect(connections).toHaveLength(2);
    expect(connections[0].signal.aborted).toBe(true);
    expect(connections[1].url).toContain('topics=a.x,b.y');
    off2();
    off3();
    await tick(60);
    expect(connections[1].signal.aborted).toBe(true);
    expect(client.getTopicRefCount('a.x')).toBe(0);
    expect(client.getState()).toBe('connecting');
  });

  it('routes events to the subscribers of their topic and reports open', async () => {
    const { client, connections } = setup();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    client.subscribe(['a.x'], (e) => a.push(e));
    client.subscribe(['b.y'], (e) => b.push(e));
    await tick(60);
    connections[0].send(frame('ready', { topics: ['a.x', 'b.y'], denied: [], transport: 'ok' }));
    connections[0].send(frame('event', { topic: 'a.x', type: 'changed', id: 3 }, '10'));
    await tick(0);
    expect(client.getState()).toBe('open');
    expect(a).toEqual([{ topic: 'a.x', type: 'changed', id: 3 }]);
    expect(b).toEqual([]);
  });

  it('notifies resync handlers', async () => {
    const { client, connections } = setup();
    const onResync = vi.fn();
    client.subscribe(['a.x'], () => undefined, { onResync });
    await tick(60);
    connections[0].send(frame('resync', {}));
    await tick(0);
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('reconnects with Last-Event-ID after the server closes the stream', async () => {
    const { client, connections } = setup();
    client.subscribe(['a.x'], () => undefined);
    await tick(60);
    connections[0].send(frame('ready', { topics: ['a.x'], denied: [], transport: 'ok' }));
    connections[0].send(frame('event', { topic: 'a.x', type: 't' }, '42'));
    connections[0].close();
    await tick(0);
    expect(client.getState()).toBe('connecting');
    await tick(1000);
    expect(connections).toHaveLength(2);
    expect(connections[1].headers['Last-Event-ID']).toBe('42');
  });

  it('backs off 1 s, 2 s then falls back after 3 failures, and recovers on ready', async () => {
    let failing = true;
    const { client, connections } = setup(() => (failing ? new Error('network') : null));
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));
    client.subscribe(['a.x'], () => undefined);
    await tick(60);
    expect(client.getState()).toBe('connecting');
    await tick(1000);
    expect(client.getState()).toBe('connecting');
    await tick(2000);
    expect(client.getState()).toBe('fallback');
    failing = false;
    await tick(4000);
    expect(connections).toHaveLength(1);
    connections[0].send(frame('ready', { topics: ['a.x'], denied: [], transport: 'ok' }));
    await tick(0);
    expect(client.getState()).toBe('open');
    expect(states).toEqual(['fallback', 'open']);
  });

  it('goes to fallback for good on 404 (module absent) without retrying', async () => {
    const error = Object.assign(new Error('HTTP 404'), { status: 404 });
    const streamGet = vi.fn();
    const { client, connections } = setup(() => {
      streamGet();
      return error;
    });
    client.subscribe(['a.x'], () => undefined);
    await tick(60);
    expect(client.getState()).toBe('fallback');
    await tick(120_000);
    expect(streamGet).toHaveBeenCalledTimes(1);
    expect(connections).toHaveLength(0);
  });

  it('follows the degraded transport state', async () => {
    const { client, connections } = setup();
    client.subscribe(['a.x'], () => undefined);
    await tick(60);
    connections[0].send(frame('ready', { topics: ['a.x'], denied: [], transport: 'ok' }));
    await tick(0);
    connections[0].send(frame('transport', { state: 'degraded' }));
    await tick(0);
    expect(client.getState()).toBe('fallback');
    connections[0].send(frame('transport', { state: 'ok' }));
    await tick(0);
    expect(client.getState()).toBe('open');
  });

  it('reconnects right away on expired (after a healthy period) and after a token refresh', async () => {
    const { client, connections, tokenRefreshed } = setup();
    client.subscribe(['a.x'], () => undefined);
    await tick(60);
    connections[0].send(frame('ready', { topics: ['a.x'], denied: [], transport: 'ok' }));
    await tick(10_000);
    connections[0].send(frame('expired', {}));
    connections[0].close();
    await tick(1);
    expect(connections).toHaveLength(2);
    connections[1].send(frame('ready', { topics: ['a.x'], denied: [], transport: 'ok' }));
    await tick(0);
    tokenRefreshed();
    await tick(0);
    expect(connections).toHaveLength(3);
    expect(connections[1].signal.aborted).toBe(true);
  });

  it('closes on sign-out and reopens on sign-in without the old Last-Event-ID', async () => {
    const { client, connections, signIn } = setup();
    client.subscribe(['a.x'], () => undefined);
    await tick(60);
    connections[0].send(frame('ready', { topics: ['a.x'], denied: [], transport: 'ok' }));
    connections[0].send(frame('event', { topic: 'a.x', type: 't' }, '5'));
    await tick(0);
    signIn(null);
    expect(connections[0].signal.aborted).toBe(true);
    expect(client.getState()).toBe('connecting');
    await tick(5000);
    expect(connections).toHaveLength(1);
    signIn('user-2');
    await tick(0);
    expect(connections).toHaveLength(2);
    expect(connections[1].headers['Last-Event-ID']).toBeUndefined();
  });

  it('keeps delivering to other handlers when one throws', async () => {
    const { client, connections } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen = vi.fn();
    client.subscribe(['a.x'], () => {
      throw new Error('boom');
    });
    client.subscribe(['a.x'], seen);
    await tick(60);
    connections[0].send(frame('event', { topic: 'a.x', type: 't' }));
    await tick(0);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(last(warn.mock.calls)?.[0]).toContain('handler failed');
    warn.mockRestore();
  });
});
