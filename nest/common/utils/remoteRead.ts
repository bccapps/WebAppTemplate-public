/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { BadGatewayException, Logger, NotFoundException } from '@nestjs/common';

/** Source of the `api_url_<moduleId>` values (the common `ConfigurationService`). */
export interface RemoteUrlSource {
  get(name: string): unknown;
}

/** Absolute `api_url_<moduleId>` (trailing slash removed), or null when the module is served by this app. */
export function remoteModuleUrl(config: RemoteUrlSource, moduleId: string): string | null {
  const url = String(config.get(`api_url_${moduleId}`) ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(url) ? url : null;
}

/** Read relays only exist for a REMOTE module: 404 otherwise (the local module serves its own routes). */
export function assertRemoteModule(config: RemoteUrlSource, moduleId: string): void {
  if (!remoteModuleUrl(config, moduleId)) throw new NotFoundException(`Module ${moduleId} is not remote`);
}

interface CacheEntry {
  value: unknown;
  at: number;
}

/**
 * In-memory TTL cache for the browser read relays of remote modules (one per process): fresh entries are served
 * as is, concurrent misses share one remote call, and a failed refresh serves the last value for up to `maxStaleMs`
 * (the remote API being down must not blank the pages). Nothing cached and the remote call failing: 502.
 * Only for data that is the same for every caller (public market data): never cache per-user answers here.
 */
export class RemoteReadCache {
  private readonly logger = new Logger(RemoteReadCache.name);
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly maxEntries = 500) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>, maxStaleMs = ttlMs * 10, now = Date.now()): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && now - entry.at < ttlMs) return entry.value as T;
    try {
      return (await this.refresh(key, load)) as T;
    } catch (error) {
      if (entry && now - entry.at < maxStaleMs) {
        this.logger.warn(`${key}: remote read failed, serving the cached value (${(error as Error).message})`);
        return entry.value as T;
      }
      this.logger.warn(`${key}: remote read failed (${(error as Error).message})`);
      throw new BadGatewayException('Remote data API unavailable');
    }
  }

  private refresh(key: string, load: () => Promise<unknown>): Promise<unknown> {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const run = load()
      .then((value: unknown) => {
        if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
          const oldest = this.entries.keys().next().value;
          if (oldest !== undefined) this.entries.delete(oldest);
        }
        this.entries.set(key, { value, at: Date.now() });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }
}
