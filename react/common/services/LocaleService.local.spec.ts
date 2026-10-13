/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeHttpResult {
  thenCb: ((v: any) => void) | null = null;
  failCb: ((v: any) => void) | null = null;
  then(cb: (v: any) => void) { this.thenCb = cb; return this; }
  fail(cb: (v: any) => void) { this.failCb = cb; return this; }
  error() { return this; }
  notAuthorized() { return this; }
}

const settings: Record<string, unknown> = {};

vi.mock('../core/http/HttpService', () => ({
  httpService: { get: vi.fn(), gets: vi.fn() },
}));
vi.mock('./ConfigurationService', () => ({
  configurationService: { get: (key: string) => settings[key], getApiUrl: () => 'http://api' },
}));

describe('LocaleService in localesLocation "local" mode', () => {
  let gets: ReturnType<typeof vi.fn>;
  let service: import('./LocaleService').LocaleService;
  let batch: FakeHttpResult;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { language: 'en-US' });
    for (const key of Object.keys(settings)) delete settings[key];
    settings.localesLocation = 'local';
    settings.localesLanguages = 'en,fr';
    gets = (await import('../core/http/HttpService')).httpService.gets as unknown as ReturnType<typeof vi.fn>;
    gets.mockClear();
    batch = new FakeHttpResult();
    gets.mockReturnValue(batch);
    service = new (await import('./LocaleService')).LocaleService();
  });

  const requested = (): Record<string, string> => gets.mock.calls[0][0] as Record<string, string>;

  it('fetches every category of every language for the "all" request (never /locales/.en.json)', () => {
    service.getLocales('');
    expect(Object.values(requested()).sort()).toEqual([
      '/locales/common.en.json',
      '/locales/common.fr.json',
      '/locales/custom.en.json',
      '/locales/custom.fr.json',
    ]);
    expect(Object.values(requested()).some((u) => u.includes('/.'))).toBe(false);
  });

  it('honours localesCategories and localesLanguages', () => {
    settings.localesCategories = ' shop , custom ';
    settings.localesLanguages = 'fr';
    service.getLocales('');
    expect(Object.values(requested()).sort()).toEqual(['/locales/custom.fr.json', '/locales/shop.fr.json']);
  });

  it('fetches only the given category when one is asked', () => {
    service.getLocales('custom');
    expect(Object.values(requested()).sort()).toEqual(['/locales/custom.en.json', '/locales/custom.fr.json']);
  });

  it('merges the categories per language, the later category winning', () => {
    const received = vi.fn();
    service.getLocales('').then(received);
    batch.thenCb?.({
      'common|en': { a: 'common a', b: 'common b' },
      'custom|en': { b: 'custom b' },
      'common|fr': { a: 'commun a' },
      'custom|fr': { c: 'perso c' },
    });
    expect(received).toHaveBeenCalledWith({
      en: { a: 'common a', b: 'custom b' },
      fr: { a: 'commun a', c: 'perso c' },
    });
  });

  it('forwards a failure of the batch', () => {
    const failed = vi.fn();
    service.getLocales('').fail(failed);
    batch.failCb?.('boom');
    expect(failed).toHaveBeenCalledWith('boom');
  });

  it('mergeLocalBatch ignores an empty or missing batch', async () => {
    const { mergeLocalBatch } = await import('./LocaleService');
    expect(mergeLocalBatch({})).toEqual({});
    expect(mergeLocalBatch(undefined as never)).toEqual({});
  });
});
