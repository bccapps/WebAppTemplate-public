/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { CommonThrottlerGuard } from './CommonThrottlerGuard';
import { FailOpenThrottlerStorage } from './FailOpenThrottlerStorage';
import { buildThrottlerOptions, throttleProviders } from './throttleProviders';
import { Test } from '@nestjs/testing';
import { ConfigurationService } from '../services/ConfigurationService';
import { RedisService } from '../services/RedisService';

const fakeRedis = (eval_: (...a: unknown[]) => Promise<unknown>) =>
  ({ getClient: () => ({ eval: eval_ }) }) as unknown as ConstructorParameters<typeof FailOpenThrottlerStorage>[0];

describe('FailOpenThrottlerStorage', () => {
  it('counts in memory without Redis and blocks above the limit', async () => {
    const storage = new FailOpenThrottlerStorage({ getClient: () => null });
    const first = await storage.increment('k', 1000, 2, 5000, 'default');
    await storage.increment('k', 1000, 2, 5000, 'default');
    const third = await storage.increment('k', 1000, 2, 5000, 'default');
    expect(first).toMatchObject({ totalHits: 1, isBlocked: false, timeToBlockExpire: 0 });
    expect(third).toMatchObject({ totalHits: 3, isBlocked: true, timeToBlockExpire: 5000 });
  });

  it('uses Redis when available', async () => {
    const evalFn = jest.fn(async () => [4, 800]);
    const storage = new FailOpenThrottlerStorage(fakeRedis(evalFn));
    const res = await storage.increment('k', 1000, 3, 0, 'default');
    expect(evalFn).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ totalHits: 4, timeToExpire: 800, isBlocked: true });
  });

  it('fails open to memory when a Redis command throws', async () => {
    const storage = new FailOpenThrottlerStorage(fakeRedis(async () => { throw new Error('down'); }));
    const res = await storage.increment('k', 1000, 3, 0, 'default');
    expect(res).toMatchObject({ totalHits: 1, isBlocked: false });
  });
});

describe('buildThrottlerOptions', () => {
  it('reads limit and window from the configuration at call time, with defaults', async () => {
    const values: Record<string, unknown> = {};
    const options = buildThrottlerOptions({ get: (k: string) => values[k] }, new FailOpenThrottlerStorage({ getClient: () => null }));
    const throttler = (options as { throttlers: { limit: () => number; ttl: () => number }[] }).throttlers[0];
    expect(throttler.limit()).toBe(300);
    expect(throttler.ttl()).toBe(60000);
    values['common_throttleDefaultLimit'] = '5';
    values['common_throttleDefaultTtlMs'] = 2000;
    expect(throttler.limit()).toBe(5);
    expect(throttler.ttl()).toBe(2000);
  });
});

describe('CommonThrottlerGuard', () => {
  const build = (config: Record<string, unknown>) => {
    const storage = new FailOpenThrottlerStorage({ getClient: () => null });
    const options = buildThrottlerOptions({ get: (k: string) => config[k] }, storage);
    const guard = new CommonThrottlerGuard(options, storage as unknown as ThrottlerStorage, new Reflector(), {
      get: (k: string) => config[k],
    } as never);
    return guard;
  };
  const ctx = (user?: { id: string }): ExecutionContext => {
    const req = { ip: '1.2.3.4', headers: {}, user };
    const res = { header: jest.fn(), setHeader: jest.fn() };
    class Ctl {
      handler(): void {}
    }
    return {
      getClass: () => Ctl,
      getHandler: () => Ctl.prototype.handler,
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
  };

  it('is a pass-through while common_throttleEnabled is not true', async () => {
    const guard = build({ common_throttleDefaultLimit: 1 });
    await guard.onModuleInit();
    for (let i = 0; i < 5; i += 1) expect(await guard.canActivate(ctx())).toBe(true);
  });

  it('rejects above the limit once enabled (also accepts the string "true")', async () => {
    const guard = build({ common_throttleEnabled: 'true', common_throttleDefaultLimit: 2 });
    await guard.onModuleInit();
    expect(await guard.canActivate(ctx())).toBe(true);
    expect(await guard.canActivate(ctx())).toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow();
  });

  it('tracks users apart from each other', async () => {
    const guard = build({ common_throttleEnabled: true, common_throttleDefaultLimit: 1 });
    await guard.onModuleInit();
    expect(await guard.canActivate(ctx({ id: 'u1' }))).toBe(true);
    expect(await guard.canActivate(ctx({ id: 'u2' }))).toBe(true);
    await expect(guard.canActivate(ctx({ id: 'u1' }))).rejects.toThrow();
  });
});

describe('Nest wiring (throttleProviders + guard, as in CommonModule)', () => {
  it('resolves the guard through the dependency injector and honours the switch', async () => {
    const config = { get: (k: string): unknown => (k === 'common_throttleEnabled' ? true : k === 'common_throttleDefaultLimit' ? 1 : undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ...throttleProviders,
        CommonThrottlerGuard,
        { provide: ConfigurationService, useValue: config },
        { provide: RedisService, useValue: { getClient: () => null } },
      ],
    }).compile();
    await moduleRef.init();
    const guard = moduleRef.get(CommonThrottlerGuard);
    expect(guard).toBeInstanceOf(CommonThrottlerGuard);
  });
});
