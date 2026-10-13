/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { Provider } from '@nestjs/common';
import { getOptionsToken, getStorageToken } from '@nestjs/throttler';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import { ConfigurationService } from '../services/ConfigurationService';
import { RedisService } from '../services/RedisService';
import { FailOpenThrottlerStorage } from './FailOpenThrottlerStorage';

const DEFAULT_LIMIT = 300;
const DEFAULT_TTL_MS = 60_000;

function numberConfig(config: Pick<ConfigurationService, 'get'>, key: string, fallback: number): number {
  const value = Number(config.get(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Throttler options whose limit and window are read from the configuration on every request. */
export function buildThrottlerOptions(config: Pick<ConfigurationService, 'get'>, storage: FailOpenThrottlerStorage): ThrottlerModuleOptions {
  return {
    storage,
    throttlers: [
      {
        name: 'default',
        limit: () => numberConfig(config, 'common_throttleDefaultLimit', DEFAULT_LIMIT),
        ttl: () => numberConfig(config, 'common_throttleDefaultTtlMs', DEFAULT_TTL_MS),
      },
    ],
  };
}

/**
 * Providers standing in for `ThrottlerModule.forRootAsync` (which cannot inject `ConfigurationService`, owned by
 * `CommonModule` itself). Scoped to `CommonModule`: an app registering its own `ThrottlerModule` is unaffected.
 */
export const throttleProviders: Provider[] = [
  {
    provide: FailOpenThrottlerStorage,
    useFactory: (redis: RedisService) => new FailOpenThrottlerStorage(redis),
    inject: [RedisService],
  },
  { provide: getStorageToken(), useExisting: FailOpenThrottlerStorage },
  {
    provide: getOptionsToken(),
    useFactory: buildThrottlerOptions,
    inject: [ConfigurationService, FailOpenThrottlerStorage],
  },
];
