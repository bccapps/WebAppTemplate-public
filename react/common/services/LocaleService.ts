/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { HttpResult } from '../../common/core/http/HttpResult';
import { httpService } from '../../common/core/http/HttpService';
import { configurationService } from '../../common/services/ConfigurationService';
import { i18n } from '../../common/core/i18n/I18n';
import { mergeModuleLocales } from './moduleLocales';

export class LocaleService {
  public preloadKey = 'LocaleService';
  /** Guards against re-fetching `/locales` when `init()` is called more than
   *  once — same double-boot issue as ConfigurationService, see its `loaded`
   *  field doc (PERFORMANCE_PLAN.md §1.4). */
  private loaded = false;
  private pendingInit: Promise<void> | null = null;
  /** Languages whose remote payload has been fetched at least once — the
   *  initial `init()` only fetches the active language (`?lang=`), so a
   *  language switch (`ensureLangLoaded`) fetches the other one lazily instead
   *  of both being loaded upfront on every boot (PERFORMANCE_PLAN.md §1.3). */
  private readonly loadedLangs = new Set<string>();
  private readonly pendingLangLoads = new Map<string, Promise<void>>();

  /** Labels bundled with the linked modules, whatever the locales mode (see `mergeModuleLocales`). */
  private getModuleLocales(): Record<string, Record<string, string>> {
    return mergeModuleLocales(import.meta.glob('/src/modules_shared/**/locales/locales.*.json', { eager: true }));
  }

  private getLocalesLocation(): 'remote' | 'local' {
    const rawLocation = configurationService.get('localesLocation');
    const normalized = typeof rawLocation === 'string' ? rawLocation.trim().toLowerCase() : '';
    return normalized === 'local' ? 'local' : 'remote';
  }

  private getLocalesLanguages(): string[] {
    const rawLanguages = configurationService.get('localesLanguages');
    const languages =
      typeof rawLanguages === 'string' && rawLanguages.trim().length > 0
        ? rawLanguages
            .split(',')
            .map((lang) => lang.trim())
            .filter((lang) => lang.length > 0)
        : [];
    if (languages.length === 0) {
      return ['en', 'fr'];
    }
    return languages;
  }

  private getLocalesCategories(): string[] {
    const rawCategories = configurationService.get('localesCategories');
    const categories =
      typeof rawCategories === 'string' && rawCategories.trim().length > 0
        ? rawCategories
            .split(',')
            .map((category) => category.trim())
            .filter((category) => category.length > 0)
        : [];
    if (categories.length === 0) {
      return ['common', 'custom'];
    }
    return categories;
  }

  /**
   * @param category Locale category (`common`, `custom`, …) or `''` for all.
   * @param lang When given AND `category` is `''` (the "all categories" remote
   * route), scopes the request to that single language (`?lang=`) instead of
   * every configured language — the frontend never needs more than the active
   * language before an explicit switch (PERFORMANCE_PLAN.md §1.3). Ignored for
   * a per-category fetch (backend route has no `lang` support there) and for
   * local mode (every configured language is already fetched in one batch).
   */
  getLocales(category: string = '', lang?: string): HttpResult {
    let ret: HttpResult;
    if (this.getLocalesLocation() === 'remote') {
      if (category != '') {
        ret = httpService.get(
          configurationService.getApiUrl() +
            '/locales/' +
            category
        );
      } else {
        const url = configurationService.getApiUrl() + '/locales' + (lang ? '?lang=' + encodeURIComponent(lang) : '');
        ret = httpService.get(url);
      }
    } else {
      const locales = this.getLocalesLanguages();
      const urls: { [id: string]: any } = {};
      for (const locale of locales) {
        urls[locale] = '/locales/' + category + '.' + locale + '.json';
      }
      ret = httpService.gets(urls, { skipTransport: true });
    }
    return ret;
  }

  /** Browser/OS language, mapped to the only two languages this app handles —
   *  French if the browser is French, English for everything else (no other
   *  locale is supported, so no broader supported-languages/config-default
   *  lookup is needed here). */
  private resolveFallbackLang(): 'fr' | 'en' {
    const browserLang =
      typeof navigator !== 'undefined' && navigator.language
        ? navigator.language.split('-')[0].toLowerCase()
        : '';
    return browserLang === 'fr' ? 'fr' : 'en';
  }

  /** The language `init()` should fetch first: the visitor's persisted choice
   *  or server-seeded default (`i18n.getLang()`, already resolvable at this
   *  point since ConfigurationService loads before LocaleService), falling
   *  back to the browser language for a first-ever visit. */
  private resolveInitialLang(): string {
    return i18n.getLang() || this.resolveFallbackLang();
  }

  init(callback: () => void): void {
    if (this.loaded) {
      callback?.();
      return;
    }
    if (!this.pendingInit) {
      this.pendingInit = new Promise<void>((resolve) => {
        const moduleLocales = this.getModuleLocales();
        if (Object.keys(moduleLocales).length > 0) {
          i18n.add(moduleLocales);
        }

        const done = () => {
          // Only resolve+apply a fallback default when the visitor has no stored
          // preference yet (first visit, or a previous visit before this browser ever
          // had one). Don't persist it: it's a fallback, not a choice — persisting it
          // would bake in the default forever and an admin changing it server-side
          // (or a returning visit under a different OS language) would never reach
          // that visitor again. An explicit choice (SwitchLanguage) already persisted
          // itself and is picked up here via i18n.getLang().
          if (!i18n.getLang()) {
            i18n.setLang(this.resolveFallbackLang(), false);
          }
          this.loaded = true;
          resolve();
        };

        const initialLang = this.resolveInitialLang();
        this.getLocales('', initialLang)
          .then((locales) => {
            i18n.add(locales);
            if (this.getLocalesLocation() === 'remote') this.loadedLangs.add(initialLang);
            done();
          })
          .fail(() => done())
          .error(() => done())
          .notAuthorized(() => done());
      });
    }
    this.pendingInit.then(() => callback?.());
  }

  /**
   * Fetches a language's remote payload on demand and merges it into `i18n` —
   * a no-op (resolves immediately) if that language was already loaded, at
   * boot or by a previous call. Used by the language switcher: since `init()`
   * only loads the active language, switching to the other one needs this
   * before `i18n.setLang()` — otherwise labels for that language would render
   * as raw keys until the next reload (PERFORMANCE_PLAN.md §1.3).
   */
  ensureLangLoaded(lang: string): Promise<void> {
    if (this.loadedLangs.has(lang)) return Promise.resolve();
    const pending = this.pendingLangLoads.get(lang);
    if (pending) return pending;
    const promise = new Promise<void>((resolve) => {
      const done = () => resolve();
      this.getLocales('', lang)
        .then((locales) => {
          i18n.add(locales);
          this.loadedLangs.add(lang);
          done();
        })
        .fail(() => done())
        .error(() => done())
        .notAuthorized(() => done());
    }).finally(() => {
      this.pendingLangLoads.delete(lang);
    });
    this.pendingLangLoads.set(lang, promise);
    return promise;
  }

}

export const localeService = new LocaleService();
