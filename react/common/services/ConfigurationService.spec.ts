/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Minimal HttpResult double — see BlockchainIndicatorService.spec.ts for the
 *  same pattern. */
class FakeHttpResult {
  private thenCb: ((v: any) => void) | null = null;
  then(cb: (v: any) => void) { this.thenCb = cb; return this; }
  fail() { return this; }
  error() { return this; }
  notAuthorized() { return this; }
  resolve(payload: any) { this.thenCb?.(payload); }
}

vi.mock('../core/http/HttpService', () => ({
  httpService: { get: vi.fn(), gets: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), registerApiToken: vi.fn() },
}));

describe('ConfigurationService.init() — idempotent (PERFORMANCE_PLAN.md §1.4)', () => {
  let httpServiceMock: { get: ReturnType<typeof vi.fn> };
  let service: import('./ConfigurationService').ConfigurationService;
  let fakeResult: FakeHttpResult;

  beforeEach(async () => {
    vi.resetModules();
    const httpModule = await import('../core/http/HttpService');
    httpServiceMock = httpModule.httpService as unknown as { get: ReturnType<typeof vi.fn> };
    // The mocked module's vi.fn() instances live in vitest's mock registry, which
    // vi.resetModules() (module registry) does NOT clear — reset call history
    // explicitly so counts don't leak between tests.
    httpServiceMock.get.mockClear();
    fakeResult = new FakeHttpResult();
    httpServiceMock.get.mockReturnValue(fakeResult);
    const mod = await import('./ConfigurationService');
    service = new mod.ConfigurationService();
  });

  it('fires a single HTTP request for two concurrent init() calls, both callbacks resolve', async () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    service.init('/api', cb1);
    service.init('/api', cb2);

    expect(httpServiceMock.get).toHaveBeenCalledTimes(1);

    fakeResult.resolve([{ name: 'featureX', value: 'on' }]);
    // init()'s callback fires via a native Promise .then() (pendingInit), which
    // is always deferred to a microtask even though FakeHttpResult itself
    // resolves synchronously — flush it.
    await Promise.resolve();
    await Promise.resolve();

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(service.get('featureX')).toBe('on');
  });

  it('a call after the first load resolves immediately without a new HTTP request', async () => {
    const cb1 = vi.fn();
    service.init('/api', cb1);
    fakeResult.resolve([{ name: 'a', value: '1' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(httpServiceMock.get).toHaveBeenCalledTimes(1);
    expect(cb1).toHaveBeenCalledTimes(1);

    const cb2 = vi.fn();
    service.init('/api', cb2);
    expect(cb2).toHaveBeenCalledTimes(1);
    // Still just the one HTTP call from the first load.
    expect(httpServiceMock.get).toHaveBeenCalledTimes(1);
  });
});
