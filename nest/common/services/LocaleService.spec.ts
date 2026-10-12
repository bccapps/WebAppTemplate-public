/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import { LocaleService } from './LocaleService';

describe('LocaleService.getAllLocales — memoized, ?lang filter (PERFORMANCE_PLAN.md §1.3)', () => {
  let service: LocaleService;
  let readFileSpy: jest.SpiedFunction<typeof fs.readFileSync>;

  beforeEach(() => {
    service = new LocaleService();
    readFileSpy = jest.spyOn(fs, 'readFileSync');
  });

  afterEach(() => {
    readFileSpy.mockRestore();
  });

  it('reads locale files from disk on the first call, and NOT again on a second call within the TTL', async () => {
    const first = await service.getAllLocales();
    expect(Object.keys(first).length).toBeGreaterThan(0);
    const readsAfterFirst = readFileSpy.mock.calls.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    readFileSpy.mockClear();
    const second = await service.getAllLocales();
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });

  it('clearAllLocalesCache() forces the next call to re-read from disk', async () => {
    await service.getAllLocales();
    readFileSpy.mockClear();

    service.clearAllLocalesCache();
    await service.getAllLocales();
    expect(readFileSpy).toHaveBeenCalled();
  });

  it('lang filters the (still cached) payload down to a single language', async () => {
    const all = await service.getAllLocales();
    const langs = Object.keys(all);
    expect(langs).toContain('en');

    readFileSpy.mockClear();
    const enOnly = await service.getAllLocales('en');
    // Filtering must not re-scan disk — served from the same memoized payload.
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(Object.keys(enOnly)).toEqual(['en']);
    expect(enOnly.en).toEqual(all.en);
  });

  it('an unknown lang returns an empty object rather than throwing', async () => {
    const result = await service.getAllLocales('zz-not-a-real-lang');
    expect(result).toEqual({});
  });
});
