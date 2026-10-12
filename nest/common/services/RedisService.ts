/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * Shared `ioredis` client for the whole app (PERFORMANCE_PLAN.md §7.9, étape 1):
 * one connection, one reconnection policy, one health signal, instead of every
 * Redis-backed feature opening its own. Generalizes the ad-hoc
 * `require('ioredis')` that used to live inside `CryptSessionService.initRedis()`
 * — that pattern is preserved here verbatim (same options), just centralized.
 *
 * **Fail-open contract (mandatory for every consumer)**: `getClient()` returns
 * `null` whenever `REDIS_URL` is unset or `ioredis` failed to load, and the
 * returned client can still have any individual command fail at any time
 * (transient outage, timeout after `maxRetriesPerRequest`). Every consumer
 * MUST treat both cases as "fall back to local/in-memory behaviour, log a
 * warning" — never as a reason to fail the caller's request. This service
 * itself never throws.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: import('ioredis').default | null = null;

  constructor() {
    this.init();
  }

  /**
   * `null` when `REDIS_URL` is unset or `ioredis` is unavailable — callers
   * must fall back to their own local/in-memory strategy in that case, and
   * must also guard every command against a later runtime failure (the
   * client can be non-null yet momentarily unable to reach Redis).
   */
  getClient(): import('ioredis').default | null {
    return this.client;
  }

  /** True once a client object was created (`REDIS_URL` was set and `ioredis` loaded) — NOT a guarantee the connection is currently up, just that commands are worth attempting (ioredis queues/retries internally). */
  isConfigured(): boolean {
    return this.client !== null;
  }

  /** True only once the connection is actually established — for a health/status view, not a per-command gate (a command can legitimately race a reconnect and still succeed via ioredis's internal queueing). */
  isReady(): boolean {
    return this.client?.status === 'ready';
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => {});
      this.client = null;
    }
  }

  private init(): void {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      this.logger.warn('[RedisService] REDIS_URL not set — every Redis-backed feature falls back to its local/in-memory behaviour.');
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Redis = require('ioredis').default ?? require('ioredis');
      this.client = new Redis(redisUrl, {
        tls: redisUrl.startsWith('rediss://') ? {} : undefined,
        maxRetriesPerRequest: 3,
        // Let ioredis manage the connection lifecycle: it auto-connects on first command
        // and auto-reconnects via retryStrategy on failure. Never null `this.client` on a
        // single failed attempt — that would permanently disable Redis for this process
        // and force every consumer into its local fallback for the rest of its lifetime.
        lazyConnect: false,
        retryStrategy: (times: number) => Math.min(times * 200, 5000),
        reconnectOnError: () => true,
      });
      this.client.on('connect', () => this.logger.log('[RedisService] Connected.'));
      this.client.on('error', (err: Error) => this.logger.warn(`[RedisService] Error (will retry): ${err.message}`));
      this.client.on('reconnecting', () => this.logger.log('[RedisService] Reconnecting…'));
    } catch (err: any) {
      this.logger.warn(`[RedisService] ioredis not available, every Redis-backed feature disabled: ${err.message}`);
      this.client = null;
    }
  }
}
