/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { LocaleController } from './LocaleController';
import { LocaleService } from '../services/LocaleService';

describe('LocaleController — passes ?lang through to LocaleService (PERFORMANCE_PLAN.md §1.3)', () => {
  it('GET /locales forwards the lang query param', async () => {
    const getAllLocales = jest.fn(async (lang?: string) => (lang ? { [lang]: {} } : { en: {}, fr: {} }));
    const fakeService = { getAllLocales } as unknown as LocaleService;
    const controller = new LocaleController(fakeService);

    const result = await controller.getAllLocales('fr');
    expect(getAllLocales).toHaveBeenCalledWith('fr');
    expect(result).toEqual({ fr: {} });
  });

  it('GET /locales with no lang returns every language', async () => {
    const getAllLocales = jest.fn(async (lang?: string) => (lang ? { [lang]: {} } : { en: {}, fr: {} }));
    const fakeService = { getAllLocales } as unknown as LocaleService;
    const controller = new LocaleController(fakeService);

    const result = await controller.getAllLocales(undefined);
    expect(getAllLocales).toHaveBeenCalledWith(undefined);
    expect(result).toEqual({ en: {}, fr: {} });
  });

  it('GET /locales/:category is unaffected by the lang param addition', async () => {
    const getLocale = jest.fn(async (category: string) => ({ [category]: 'value' }));
    const fakeService = { getLocale } as unknown as LocaleService;
    const controller = new LocaleController(fakeService);

    const result = await controller.getLocale('common');
    expect(getLocale).toHaveBeenCalledWith('common');
    expect(result).toEqual({ common: 'value' });
  });
});
