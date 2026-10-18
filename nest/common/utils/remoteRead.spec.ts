/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { assertRemoteModule, RemoteReadCache, remoteModuleUrl } from './remoteRead';

const config = (values: Record<string, unknown>) => ({ get: (name: string) => values[name] });

describe('remoteModuleUrl / assertRemoteModule', () => {
  it('keeps only absolute URLs', () => {
    expect(remoteModuleUrl(config({ 'api_url_x': 'https://ctd.example/api/v1/' }), 'x')).toBe('https://ctd.example/api/v1');
    expect(remoteModuleUrl(config({ 'api_url_x': '/api/v1' }), 'x')).toBeNull();
    expect(remoteModuleUrl(config({}), 'x')).toBeNull();
  });

  it('answers 404 for a module served locally', () => {
    expect(() => assertRemoteModule(config({}), 'x')).toThrow(NotFoundException);
    expect(() => assertRemoteModule(config({ 'api_url_x': 'http://h/api/v1' }), 'x')).not.toThrow();
  });
});

describe('RemoteReadCache', () => {
  it('serves a fresh entry without calling the remote API again', async () => {
    const cache = new RemoteReadCache();
    const load = jest.fn(async () => ({ v: 1 }));
    await cache.get('k', 60_000, load);
    await expect(cache.get('k', 60_000, load)).resolves.toEqual({ v: 1 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shares one remote call between concurrent misses', async () => {
    const cache = new RemoteReadCache();
    const load = jest.fn(async () => 'v');
    await Promise.all([cache.get('k', 1000, load), cache.get('k', 1000, load), cache.get('k', 1000, load)]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves the stale value when the refresh fails, 502 when nothing is cached', async () => {
    const cache = new RemoteReadCache();
    await cache.get('k', 10, async () => 'old');
    const failing = async (): Promise<string> => { throw new Error('down'); };
    await expect(cache.get('k', 10, failing, 60_000, Date.now() + 20)).resolves.toBe('old');
    await expect(cache.get('other', 10, failing)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('gives up on a value older than maxStaleMs', async () => {
    const cache = new RemoteReadCache();
    await cache.get('k', 10, async () => 'old');
    await expect(cache.get('k', 10, async () => { throw new Error('down'); }, 100, Date.now() + 1000)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('evicts the oldest key beyond maxEntries', async () => {
    const cache = new RemoteReadCache(2);
    for (const key of ['a', 'b', 'c']) await cache.get(key, 60_000, async () => key);
    const load = jest.fn(async () => 'a2');
    await expect(cache.get('a', 60_000, load)).resolves.toBe('a2');
    expect(load).toHaveBeenCalledTimes(1);
  });
});
