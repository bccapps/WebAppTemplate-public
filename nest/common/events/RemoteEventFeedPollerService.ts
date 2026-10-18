/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../services/RedisService';
import { EventFeedPage, FeedEvent } from './eventFeed';
import { remoteApiAuthHeaders } from '../utils/remoteApiAuth';

const PAGE_SIZE = 200;
const MAX_PAGES_PER_POLL = 5;
const TIMEOUT_MS = 15_000;

export interface EventFeedPollOptions<P> {
  /** Stable id of the feed, keys the cursor (e.g. 'wallet-intelligence'). */
  feedId: string;
  /** Feed endpoint, e.g. `<api_url_x>/x/events`. */
  url: string;
  /** Handles one event; the cursor moves past it once this resolves (at-least-once on crash). */
  onEvent: (event: FeedEvent<P>) => Promise<void>;
}

/**
 * Consumer side of a pull-based event feed (see eventFeed.ts): reads the events after its cursor,
 * authenticated server-side with `remoteApiAuthHeaders()` (scoped `REMOTE_API_KEY`, legacy `TECH_TOKEN` fallback), and hands them over in order. A new consumer (no
 * cursor) starts at the feed's latest id — no replay of the history. The cursor lives in Redis so
 * it is shared by instances and survives restarts; without Redis it is kept in memory. Callers are
 * expected to run it from a single instance (worker + lock). Never throws.
 */
@Injectable()
export class RemoteEventFeedPollerService {
  private readonly logger = new Logger(RemoteEventFeedPollerService.name);
  private readonly memoryCursors = new Map<string, number>();

  constructor(private readonly redisService: RedisService) {}

  async poll<P>({ feedId, url, onEvent }: EventFeedPollOptions<P>): Promise<number> {
    try {
      const cursor = await this.readCursor(feedId);
      if (cursor === null) {
        const { latestId } = await this.fetchPage<P>(url, null);
        await this.writeCursor(feedId, latestId);
        return 0;
      }
      let handled = 0;
      let afterId = cursor;
      for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
        const { events } = await this.fetchPage<P>(url, afterId);
        for (const event of events) {
          await onEvent(event);
          afterId = event.id;
          await this.writeCursor(feedId, afterId);
          handled += 1;
        }
        if (events.length < PAGE_SIZE) break;
      }
      return handled;
    } catch (error) {
      this.logger.warn(`Event feed '${feedId}' poll failed: ${(error as Error).message}`);
      return 0;
    }
  }

  private async fetchPage<P>(url: string, afterId: number | null): Promise<EventFeedPage<P>> {
    const query = afterId === null ? '' : `?afterId=${afterId}&limit=${PAGE_SIZE}`;
    const response = await fetch(url + query, {
      headers: { Accept: 'application/json', ...remoteApiAuthHeaders() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} on ${url}`);
    return (await response.json()) as EventFeedPage<P>;
  }

  private cursorKey(feedId: string): string {
    return `event-feed-cursor:${feedId}`;
  }

  private async readCursor(feedId: string): Promise<number | null> {
    const client = this.redisService.getClient();
    const raw = client ? await client.get(this.cursorKey(feedId)) : this.memoryCursors.get(feedId)?.toString() ?? null;
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  private async writeCursor(feedId: string, id: number): Promise<void> {
    const client = this.redisService.getClient();
    if (client) await client.set(this.cursorKey(feedId), String(id));
    else this.memoryCursors.set(feedId, id);
  }
}
