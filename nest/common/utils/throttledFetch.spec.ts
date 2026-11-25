/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { resetThrottleBuckets, throttledFetchJson, type ThrottledFetchTransport } from './throttledFetch';

const reply = (status: number, body: unknown = null): ThrottledFetchTransport => async () => ({ status, body, retryAfter: null });
const options = (transport: ThrottledFetchTransport, maxRetries = 1) => ({ timeoutMs: 1000, maxRetries, minIntervalMs: 0, maxBackoffMs: 1, transport });

describe('throttledFetchJson logging', () => {
  let warn: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    resetThrottleBuckets();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());
  const lines = (): string[] => warn.mock.calls.map((call) => String(call[0]));

  it('returns the body of a 2xx without logging', async () => {
    const result = await throttledFetchJson<{ ok: boolean }>('src', 'https://example.test/x', options(reply(200, { ok: true })));
    expect(result).toEqual({ data: { ok: true }, stale: false, status: 200, rateLimited: false });
    expect(lines()).toEqual([]);
  });

  it('logs the retry and, when the last allowed attempt is also a 5xx, that it gave up (the source status stays visible)', async () => {
    const result = await throttledFetchJson('oecd-sdmx', 'https://example.test/x', options(reply(500), 1));
    expect(result).toMatchObject({ data: null, stale: true, status: 500, rateLimited: false });
    expect(lines().filter((line) => line.includes('HTTP 500, retry'))).toHaveLength(1);
    expect(lines()).toContain('oecd-sdmx HTTP 500, giving up after 2 attempt(s)');
  });

  it('logs a 429 that exhausted its retries as rate-limited', async () => {
    const result = await throttledFetchJson('gdelt', 'https://example.test/x', options(reply(429), 0));
    expect(result.rateLimited).toBe(true);
    expect(lines()).toEqual(['gdelt HTTP 429, giving up after 1 attempt(s)']);
  });

  it('logs a 401 or 403 refusal once per source and status (not per call), with the status and the source only', async () => {
    const url = 'https://example.test/calendar?c=SECRETKEY123';
    for (let call = 0; call < 3; call += 1) expect(await throttledFetchJson('te', url, options(reply(403)))).toMatchObject({ data: null, status: 403 });
    await throttledFetchJson('te', url, options(reply(401)));
    expect(lines()).toHaveLength(2);
    expect(lines()[0]).toContain('te HTTP 403: request refused');
    expect(lines()[1]).toContain('te HTTP 401: request refused');
    expect(JSON.stringify(lines())).not.toMatch(/SECRETKEY123|example\.test/);
  });

  it('stays silent on the other 4xx (404 of a withdrawn series, unknown symbol)', async () => {
    expect(await throttledFetchJson('fred', 'https://example.test/x', options(reply(404)))).toMatchObject({ data: null, status: 404 });
    expect(lines()).toEqual([]);
  });
});
