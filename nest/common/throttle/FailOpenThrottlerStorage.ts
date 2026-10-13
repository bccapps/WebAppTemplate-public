/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { RedisService } from '../services/RedisService';

/** Same shape as `ThrottlerStorageRecord` (not exported as a type by `@nestjs/throttler`). */
export interface ThrottlerHit {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

interface MemoryEntry {
  count: number;
  reset: number;
}

const GC_THRESHOLD = 1000;

// INCR then PEXPIRE on the first hit only (works on Redis 6+, unlike PEXPIRE NX).
const LUA_INCREMENT = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  return {c, redis.call('PTTL', KEYS[1])}
`;

/**
 * Rate-limit counters shared through the app-wide Redis client (`RedisService`), fixed window, atomic Lua script.
 * **Fail open**: without `REDIS_URL`, or when a Redis command fails, counting falls back to an in-process map
 * (per replica) and never rejects the request because of the storage. Without Redis and with N replicas the
 * effective limit is N times the configured one.
 */
export class FailOpenThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(FailOpenThrottlerStorage.name);
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(private readonly redis: Pick<RedisService, 'getClient'>) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerHit> {
    const redisKey = `thr:${throttlerName}:${key}`;
    const viaRedis = await this.incrementRedis(redisKey, ttl);
    const [hits, timeToExpire] = viaRedis ?? this.incrementMemory(redisKey, ttl);
    const isBlocked = hits > limit;
    return { totalHits: hits, timeToExpire, isBlocked, timeToBlockExpire: isBlocked ? blockDuration : 0 };
  }

  private async incrementRedis(redisKey: string, ttl: number): Promise<[number, number] | null> {
    const client = this.redis.getClient();
    if (!client) return null;
    try {
      const result = (await client.eval(LUA_INCREMENT, 1, redisKey, ttl)) as [number, number];
      return [result[0], Math.max(0, result[1])];
    } catch (err) {
      this.logger.warn(`Redis increment failed (${(err as Error).message}), using the in-process counter`);
      return null;
    }
  }

  private incrementMemory(key: string, ttl: number): [number, number] {
    const now = Date.now();
    const entry = this.memory.get(key);
    if (!entry || entry.reset <= now) {
      this.memory.set(key, { count: 1, reset: now + ttl });
      this.gc(now);
      return [1, ttl];
    }
    entry.count += 1;
    return [entry.count, Math.max(0, entry.reset - now)];
  }

  /** Drops expired entries so the map cannot grow without bound. */
  private gc(now: number): void {
    if (this.memory.size < GC_THRESHOLD) return;
    for (const [k, v] of this.memory) if (v.reset <= now) this.memory.delete(k);
  }
}
