/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { RemoteEventFeedPollerService } from './RemoteEventFeedPollerService';
import { FeedEvent } from './eventFeed';

type Feed = { events: FeedEvent[]; latestId: number };
const event = (id: number): FeedEvent => ({ id, type: 't', payload: { n: id }, createdAt: '2026-09-23T00:00:00.000Z' });

const fakeRedis = () => {
  const store = new Map<string, string>();
  return { store, service: { getClient: () => ({ get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: string) => { store.set(key, value); } }) } };
};

const mockFeed = (handler: (afterId: number | null) => Feed | Error): jest.Mock => {
  const fetchMock = jest.fn(async (url: unknown) => {
    const match = /afterId=(\d+)/.exec(String(url));
    const result = handler(match ? Number(match[1]) : null);
    if (result instanceof Error) throw result;
    return { ok: true, status: 200, json: async () => result } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

describe('RemoteEventFeedPollerService', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('a new consumer starts at latestId without replaying the history', async () => {
    const { store, service } = fakeRedis();
    mockFeed(() => ({ events: [], latestId: 42 }));
    const onEvent = jest.fn(async () => undefined);
    await expect(new RemoteEventFeedPollerService(service as never).poll({ feedId: 'f', url: 'https://api/x/events', onEvent })).resolves.toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
    expect(store.get('event-feed-cursor:f')).toBe('42');
  });

  it('hands events over in order and moves the cursor past each one', async () => {
    const { store, service } = fakeRedis();
    store.set('event-feed-cursor:f', '10');
    const fetchMock = mockFeed((afterId) => ({ events: afterId === 10 ? [event(11), event(12)] : [], latestId: 12 }));
    const seen: number[] = [];
    await new RemoteEventFeedPollerService(service as never).poll({ feedId: 'f', url: 'https://api/x/events', onEvent: async (e) => { seen.push(e.id); } });
    expect(seen).toEqual([11, 12]);
    expect(store.get('event-feed-cursor:f')).toBe('12');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api/x/events?afterId=10&limit=200');
  });

  it('keeps the cursor on the last handled event when a handler fails, and never throws', async () => {
    const { store, service } = fakeRedis();
    store.set('event-feed-cursor:f', '0');
    mockFeed(() => ({ events: [event(1), event(2)], latestId: 2 }));
    const onEvent = async (e: FeedEvent): Promise<void> => { if (e.id === 2) throw new Error('telegram down'); };
    await expect(new RemoteEventFeedPollerService(service as never).poll({ feedId: 'f', url: 'https://api/x/events', onEvent })).resolves.toBe(0);
    expect(store.get('event-feed-cursor:f')).toBe('1');
  });

  it('survives an unreachable API', async () => {
    const { service } = fakeRedis();
    mockFeed(() => new Error('ECONNREFUSED'));
    await expect(new RemoteEventFeedPollerService(service as never).poll({ feedId: 'f', url: 'https://api/x/events', onEvent: async () => undefined })).resolves.toBe(0);
  });
});
