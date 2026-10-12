/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { lastValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CacheControlInterceptor } from './CacheControlInterceptor';
import { CacheControl } from '../decorators/CacheControl';
import type { ConfigurationService } from '../services/ConfigurationService';

class FakeCachedController {
  @CacheControl({
    visibility: 'public',
    maxAgeConfigKey: 'fake_maxAge',
    staleWhileRevalidateConfigKey: 'fake_swr',
  })
  publicRoute(): void {}

  @CacheControl({ visibility: 'private', maxAgeConfigKey: 'fake_privateMaxAge' })
  privateRoute(): void {}

  @CacheControl({
    visibility: 'private',
    maxAgeConfigKey: 'fake_privateMaxAge',
    vary: ['Authorization'],
  })
  perViewerRoute(): void {}

  uncachedRoute(): void {}
}

describe('CacheControlInterceptor (PERFORMANCE_PLAN.md §2.1)', () => {
  const body = { hello: 'world' };
  const handler: CallHandler = { handle: () => of(body) };

  const buildContext = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    routeHandler: (...args: any[]) => unknown,
  ): {
    context: ExecutionContext;
    response: {
      setHeader: ReturnType<typeof jest.fn>;
      vary: ReturnType<typeof jest.fn>;
      writableEnded: boolean;
      headersSent: boolean;
    };
  } => {
    const response = { setHeader: jest.fn(), vary: jest.fn(), writableEnded: false, headersSent: false };
    const context = {
      getType: () => 'http',
      getHandler: () => routeHandler,
      getClass: () => FakeCachedController,
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ExecutionContext;
    return { context, response };
  };

  const buildInterceptor = (values: Record<string, unknown>): CacheControlInterceptor => {
    const configurationService = { get: jest.fn((key: string) => values[key]) };
    return new CacheControlInterceptor(new Reflector(), configurationService as unknown as ConfigurationService);
  };

  it('sets Cache-Control with max-age and stale-while-revalidate resolved from config', async () => {
    const interceptor = buildInterceptor({ fake_maxAge: 300, fake_swr: 86400 });
    const { context, response } = buildContext(FakeCachedController.prototype.publicRoute);

    await lastValueFrom(interceptor.intercept(context, handler));

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  });

  it('omits stale-while-revalidate when the decorator does not declare it, and honors private visibility', async () => {
    const interceptor = buildInterceptor({ fake_privateMaxAge: 300 });
    const { context, response } = buildContext(FakeCachedController.prototype.privateRoute);

    await lastValueFrom(interceptor.intercept(context, handler));

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=300');
  });

  it('appends the declared Vary headers so the browser cache keeps one entry per viewer', async () => {
    const interceptor = buildInterceptor({ fake_privateMaxAge: 300 });
    const { context, response } = buildContext(FakeCachedController.prototype.perViewerRoute);

    await lastValueFrom(interceptor.intercept(context, handler));

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=300');
    expect(response.vary).toHaveBeenCalledWith('Authorization');
  });

  it('leaves Vary untouched when the decorator does not declare it', async () => {
    const interceptor = buildInterceptor({ fake_privateMaxAge: 300 });
    const { context, response } = buildContext(FakeCachedController.prototype.privateRoute);

    await lastValueFrom(interceptor.intercept(context, handler));

    expect(response.vary).not.toHaveBeenCalled();
  });

  it('does nothing on a route without @CacheControl', async () => {
    const interceptor = buildInterceptor({});
    const { context, response } = buildContext(FakeCachedController.prototype.uncachedRoute);

    const result = await lastValueFrom(interceptor.intercept(context, handler));

    expect(result).toBe(body);
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('fails safe to max-age=0 when the configured key is missing/non-numeric', async () => {
    const interceptor = buildInterceptor({ fake_maxAge: undefined, fake_swr: 'not-a-number' });
    const { context, response } = buildContext(FakeCachedController.prototype.publicRoute);

    await lastValueFrom(interceptor.intercept(context, handler));

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=0, stale-while-revalidate=0');
  });
});
