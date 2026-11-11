/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * The first-use race of the VAPID pair (review F8) with TWO instances: each has its own configuration cache that, like
 * `common`'s `ConfigurationService`, keeps a value up to 5 s (a write reloads the writer's cache only), over one shared
 * store, and a lock that is non-blocking like `CronLockService.runExclusive` on Postgres. A second instance must never
 * generate (and overwrite) a pair the first one has stored: every subscription signed with it would break.
 */
import { describe, expect, it } from '@jest/globals';
import type { ConfigurationService } from '../../common/services/ConfigurationService';
import type { CronLockService } from '../../common/services/CronLockService';
import type { ModuleConfigService } from '../../common/services/ModuleConfigService';
import { ConfigVapidKeySource } from './ConfigVapidKeySource';

const PRIVATE_KEY = 'interaction_vapidPrivateKey';

class SharedStore {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];
  held = new Set<string>();
  /** A slow database write (the first instance is still writing while the second one looks). */
  writeDelayMs = 0;
}

/** ONE instance's `ModuleConfigService` + `ConfigurationService`: a cache reloaded when older than 5 s, or after its own write. */
class InstanceConfig {
  private cache = new Map<string, string>();
  private loadedAt = -Infinity;
  constructor(private readonly store: SharedStore) {}
  private reload(): void {
    this.cache = new Map(this.store.values);
    this.loadedAt = Date.now();
  }
  async getConfiguration(): Promise<unknown[]> {
    if (Date.now() - this.loadedAt > 5000) this.reload();
    return [];
  }
  getDecryptedSecretValue(_moduleId: string, key: string): string {
    return this.cache.get(key) ?? '';
  }
  getResolvedValue(key: string): unknown {
    return this.cache.get(key) ?? null;
  }
  /** As in `common`: the values are written, then the cache is reloaded (`updateAll` drops the cache's age). */
  async updateModuleConfig(_moduleId: string, values: Record<string, unknown>): Promise<null> {
    for (const [key, value] of Object.entries(values)) {
      if (this.store.writeDelayMs) await new Promise((resolve) => setTimeout(resolve, this.store.writeDelayMs));
      this.store.values.set(key, String(value));
      this.store.writes.push(key);
    }
    this.reload();
    return null;
  }
}

/** `runExclusive` across instances: false at once while another instance holds the key (Postgres lease semantics). */
class SharedLock {
  constructor(private readonly store: SharedStore) {}
  async runExclusive(key: string, callback: () => Promise<void>): Promise<boolean> {
    if (this.store.held.has(key)) return false;
    this.store.held.add(key);
    try {
      await callback();
      return true;
    } finally {
      this.store.held.delete(key);
    }
  }
}

function instance(store: SharedStore): { source: ConfigVapidKeySource; config: InstanceConfig } {
  const config = new InstanceConfig(store);
  const source = new ConfigVapidKeySource(config as unknown as ModuleConfigService, config as unknown as ConfigurationService, new SharedLock(store) as unknown as CronLockService);
  return { source, config };
}

describe('ConfigVapidKeySource: first-use race between instances (review F8)', () => {
  it('an instance whose cache predates the other one’s write uses the stored pair instead of generating its own', async () => {
    const store = new SharedStore();
    const a = instance(store);
    const b = instance(store);
    await Promise.all([a.config.getConfiguration(), b.config.getConfiguration()]); // both caches loaded, empty, fresh
    const first = await a.source.keys();
    const second = await b.source.keys();
    expect(second.privateKey).toBe(first.privateKey);
    expect(second.publicKey).toBe(first.publicKey);
    expect(store.writes.filter((key) => key === PRIVATE_KEY)).toHaveLength(1);
  });

  it('two instances asking at the same time, the first one slow to write: one pair, written once, served to both', async () => {
    const store = new SharedStore();
    store.writeDelayMs = 300;
    const a = instance(store);
    const b = instance(store);
    await Promise.all([a.config.getConfiguration(), b.config.getConfiguration()]);
    const [first, second] = await Promise.all([a.source.keys(), b.source.keys()]);
    expect(second.privateKey).toBe(first.privateKey);
    expect(store.writes.filter((key) => key === PRIVATE_KEY)).toHaveLength(1);
    expect(first.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
