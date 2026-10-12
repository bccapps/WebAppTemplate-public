/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { EVENT_FEED_MAX_LIMIT, readEventFeed } from './eventFeed';

const repo = (maxId: number | null) => {
  const find = jest.fn(async () => [{ id: 8, type: 't', payload: { a: 1 }, createdAt: new Date('2026-09-23T10:00:00Z') }]);
  return { find, value: { createQueryBuilder: () => ({ select: () => ({ getRawOne: async () => ({ max: maxId }) }) }), find } as never };
};

describe('readEventFeed', () => {
  it('without afterId returns only latestId (a new consumer does not replay history)', async () => {
    const { find, value } = repo(41);
    await expect(readEventFeed(value, null, 100)).resolves.toEqual({ events: [], latestId: 41 });
    expect(find).not.toHaveBeenCalled();
  });

  it('returns events after the cursor, oldest first, with a clamped limit and ISO dates', async () => {
    const { find, value } = repo(8);
    const page = await readEventFeed(value, 7, 10_000);
    expect(page).toEqual({ events: [{ id: 8, type: 't', payload: { a: 1 }, createdAt: '2026-09-23T10:00:00.000Z' }], latestId: 8 });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ order: { id: 'ASC' }, take: EVENT_FEED_MAX_LIMIT }));
  });

  it('an empty feed has latestId 0', async () => {
    await expect(readEventFeed(repo(null).value, null, 10)).resolves.toEqual({ events: [], latestId: 0 });
  });
});
