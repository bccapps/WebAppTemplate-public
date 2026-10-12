/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { LessThan, MoreThan, Repository } from 'typeorm';
import { EventFeedEntityBase } from './EventFeedEntityBase';

/**
 * Pull-based event feed: the producing module appends events to its own table, consumer apps poll
 * `GET …/events?afterId=` with a cursor (RemoteEventFeedPollerService). The producer never calls
 * its consumers — it doesn't even know them.
 */
export interface FeedEvent<P = Record<string, unknown>> {
  id: number;
  type: string;
  payload: P;
  createdAt: string;
}

export interface EventFeedPage<P = Record<string, unknown>> {
  events: FeedEvent<P>[];
  /** Highest id in the feed — what a new consumer starts from (no replay of the history). */
  latestId: number;
}

export const EVENT_FEED_MAX_LIMIT = 500;

export async function appendFeedEvent<E extends EventFeedEntityBase>(repo: Repository<E>, type: string, payload: object): Promise<void> {
  await repo.insert({ type, payload } as never);
}

/** Events strictly after `afterId`, oldest first. Without `afterId`, only `latestId` (empty page). */
export async function readEventFeed<E extends EventFeedEntityBase>(repo: Repository<E>, afterId: number | null, limit: number): Promise<EventFeedPage> {
  const latest = await repo.createQueryBuilder('e').select('MAX(e.id)', 'max').getRawOne<{ max: number | string | null }>();
  const latestId = Number(latest?.max ?? 0);
  if (afterId === null) return { events: [], latestId };
  const rows = await repo.find({
    where: { id: MoreThan(afterId) } as never,
    order: { id: 'ASC' } as never,
    take: Math.min(Math.max(limit, 1), EVENT_FEED_MAX_LIMIT),
  });
  return {
    events: rows.map(({ id, type, payload, createdAt }) => ({ id, type, payload, createdAt: createdAt.toISOString() })),
    latestId,
  };
}

/** Deletes events older than `retentionDays`; returns how many. */
export async function purgeEventFeed<E extends EventFeedEntityBase>(repo: Repository<E>, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(retentionDays, 1) * 24 * 60 * 60_000);
  const result = await repo.delete({ createdAt: LessThan(cutoff) } as never);
  return result.affected ?? 0;
}
