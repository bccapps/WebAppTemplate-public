/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { RedisService } from './RedisService';

// PERFORMANCE_PLAN.md §7.9, étape 1: this is the app's dev/current-prod
// default (REDIS_URL unset, see the .env/docker-compose note in the plan) —
// every consumer must degrade the same way this service itself does.
describe('RedisService (§7.9)', () => {
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it('is a safe no-op client when REDIS_URL is not set (dev/current-prod default)', async () => {
    delete process.env.REDIS_URL;
    const service = new RedisService();
    expect(service.getClient()).toBeNull();
    expect(service.isConfigured()).toBe(false);
    expect(service.isReady()).toBe(false);
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
