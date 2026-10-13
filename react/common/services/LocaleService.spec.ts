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
  private thenCb: ((v: any) => void) | null = null;
  then(cb: (v: any) => void) { this.thenCb = cb; return this; }
  fail() { return this; }
  error() { return this; }
  notAuthorized() { return this; }
  resolve(payload: any) { this.thenCb?.(payload); }
}

vi.mock('../core/http/HttpService', () => ({
  httpService: { get: vi.fn(), gets: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

describe('LocaleService — lang-scoped fetch (§1.3) + idempotent init (§1.4)', () => {
  let httpServiceMock: { get: ReturnType<typeof vi.fn>; gets: ReturnType<typeof vi.fn> };
  let service: import('./LocaleService').LocaleService;
  let i18nMod: typeof import('../core/i18n/I18n');
  let fakeResult: FakeHttpResult;

  beforeEach(async () => {
    vi.resetModules();
    // Node >= 21 exposes `navigator.language` from the machine locale: pin it so the "en" fallback is deterministic.
    vi.stubGlobal('navigator', { language: 'en-US' });
    const httpModule = await import('../core/http/HttpService');
    httpServiceMock = httpModule.httpService as unknown as { get: ReturnType<typeof vi.fn>; gets: ReturnType<typeof vi.fn> };
    httpServiceMock.get.mockClear();
    httpServiceMock.gets.mockClear();
    fakeResult = new FakeHttpResult();
    httpServiceMock.get.mockReturnValue(fakeResult);
    i18nMod = await import('../core/i18n/I18n');
    // No stored preference and no app default: the app's `localeDefault` must not leak into these tests.
    i18nMod.i18n.setLang('', false);
    const mod = await import('./LocaleService');
    service = new mod.LocaleService();
  });

  it('init() fetches only the active language (no stored preference → falls back to "en" in a node test env)', async () => {
    const cb = vi.fn();
    service.init(cb);

    expect(httpServiceMock.get).toHaveBeenCalledTimes(1);
    const requestedUrl = httpServiceMock.get.mock.calls[0][0] as string;
    expect(requestedUrl).toContain('/locales');
    expect(requestedUrl).toContain('lang=en');

    fakeResult.resolve({ en: { 'common.hello': 'Hello' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(i18nMod.i18n.getLang()).toBe('en');
  });

  it('init() is idempotent — a second call piggybacks the first, no second HTTP request', async () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    service.init(cb1);
    service.init(cb2);
    expect(httpServiceMock.get).toHaveBeenCalledTimes(1);

    fakeResult.resolve({ en: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    const cb3 = vi.fn();
    service.init(cb3);
    expect(cb3).toHaveBeenCalledTimes(1);
    expect(httpServiceMock.get).toHaveBeenCalledTimes(1);
  });

  it('ensureLangLoaded() fetches a not-yet-loaded language once, and is a no-op afterwards', async () => {
    // Boot with 'en' first.
    service.init(vi.fn());
    fakeResult.resolve({ en: { 'common.hello': 'Hello' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(httpServiceMock.get).toHaveBeenCalledTimes(1);

    // Switching to 'fr': not loaded yet → fetches it.
    const frResult = new FakeHttpResult();
    httpServiceMock.get.mockReturnValue(frResult);
    const ensurePromise = service.ensureLangLoaded('fr');
    expect(httpServiceMock.get).toHaveBeenCalledTimes(2);
    const frUrl = httpServiceMock.get.mock.calls[1][0] as string;
    expect(frUrl).toContain('lang=fr');

    frResult.resolve({ fr: { 'common.hello': 'Bonjour' } });
    await ensurePromise;
    expect(i18nMod.i18n.getForLang('common.hello', 'fr')).toBe('Bonjour');

    // Switching back to 'fr' again (already loaded) → no new request.
    await service.ensureLangLoaded('fr');
    expect(httpServiceMock.get).toHaveBeenCalledTimes(2);

    // 'en' was loaded at init() time too → no new request either.
    await service.ensureLangLoaded('en');
    expect(httpServiceMock.get).toHaveBeenCalledTimes(2);
  });

  it('ensureLangLoaded() dedupes two concurrent calls for the same not-yet-loaded language', async () => {
    service.init(vi.fn());
    fakeResult.resolve({ en: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(httpServiceMock.get).toHaveBeenCalledTimes(1);

    const frResult = new FakeHttpResult();
    httpServiceMock.get.mockReturnValue(frResult);
    const p1 = service.ensureLangLoaded('fr');
    const p2 = service.ensureLangLoaded('fr');
    expect(httpServiceMock.get).toHaveBeenCalledTimes(2); // one fetch for 'fr', shared

    frResult.resolve({ fr: {} });
    await Promise.all([p1, p2]);
    expect(httpServiceMock.get).toHaveBeenCalledTimes(2);
  });

  it('init() serves the labels bundled with the modules (react/common/locales) when the remote payload does not carry them', async () => {
    service.init(vi.fn());
    fakeResult.resolve({ en: { 'custom.only': 'Remote' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(i18nMod.i18n.getForLang('custom.only', 'en')).toBe('Remote');
    expect(i18nMod.i18n.getForLang('common.richtext.editor.bold', 'en')).toBe('Bold');
  });

  it('init() still serves the bundled labels when the remote fetch fails', async () => {
    class FailingResult extends FakeHttpResult {
      private failCb: (() => void) | null = null;
      fail(cb?: () => void) { this.failCb = cb ?? null; return this; }
      reject() { this.failCb?.(); }
    }
    const failing = new FailingResult();
    httpServiceMock.get.mockReturnValue(failing);
    const cb = vi.fn();
    service.init(cb);
    failing.reject();
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(i18nMod.i18n.getForLang('common.richtext.editor.bold', 'en')).toBe('Bold');
  });

  it('a remote key overrides the bundled label of the same key (app customisation wins)', async () => {
    service.init(vi.fn());
    fakeResult.resolve({ en: { 'common.richtext.editor.bold': 'Strong' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(i18nMod.i18n.getForLang('common.richtext.editor.bold', 'en')).toBe('Strong');
  });
});
