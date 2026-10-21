/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { configurationService } from '../../services/ConfigurationService';
import EventObject from '../eventObject/EventObject';
import { appSession } from '../session/AppSession';

export type I18nLabelParams = any[] | null;

class I18n extends EventObject {
  private locales: Record<string, any>;
  private currentLang: string;
  private availableLangs: string;

  constructor() {
    super();
    const configuredLocales = configurationService.get('locales');
    const configuredLangs =
      configurationService.get('localesLanguages') ||
      (typeof configuredLocales === 'string' ? configuredLocales : undefined);

    this.availableLangs = typeof configuredLangs === 'string' ? configuredLangs : '';
    this.locales =
      configuredLocales && typeof configuredLocales === 'object'
        ? { ...configuredLocales }
        : {};

    this.currentLang = appSession.get('lang');
    if (!this.currentLang) this.currentLang = configurationService.get('localeDefault');
  }

  /**
   *
   * @param newLocales
   */
  public add = (newLocales: any): void => {
    if (!newLocales || typeof newLocales !== 'object') return;
    if (!this.locales || typeof this.locales !== 'object') {
      this.locales = {};
    }
    const keys: string[] = Object.keys(newLocales);
    keys.forEach((key) => {
      console.log('Adding new locale => ' + key);
      if (!(key in this.locales)) {
        this.locales[key] = newLocales[key];
      } else {
        this.locales[key] = { ...this.locales[key], ...newLocales[key] };
      }
    });
    console.log('FULL LOCALES: %o', this.locales);
  };

  /**
   * set the lang
   * @param lang lang
   * @param persist whether to remember this choice for the visitor's next visit
   * (localStorage). Explicit user choices (language switcher) must persist; a
   * computed fallback (no stored preference yet) must not — otherwise it gets
   * baked in forever and a later change to the app's default language never
   * reaches that visitor again.
   */
  public setLang = (lang: string, persist: boolean = true): void => {
    this.currentLang = lang;
    if (persist) appSession.set('lang', lang);
    this.dispatchEvent('languageChanged', { lang: this.currentLang });
    //console.log('Lang changed to : ' + lang);
  };

  /**
   *
   * @returns
   */
  public getLang = (): string => {
    return this.currentLang;
  };

  /**
   *
   * @returns
   */
  public getLangs = (): string[] => {
    let ret: string[];
    if (this.availableLangs && this.availableLangs.trim().length > 0) {
      ret = this.availableLangs
        .split(',')
        .map((lang) => lang.trim())
        .filter((lang) => lang.length > 0);
    } else {
      ret = Object.keys(this.locales);
    }
    return ret;
  };

  /**
   * get label for the key and current lang
   * @param key
   * @param params
   * @returns
   */
  public get = (key: string, params?: any[] | null): string => {
    let retour: string = key;
    const localesForLang: any = this.locales[this.currentLang];
    if (localesForLang) {
      let label: string = localesForLang[key];
      if (label) {
        if (params && params.length > 0) {
          for (let i = 0; i < params.length; i++) {
            label = label.replace(
              '{' + i + '}',
              params[i] != undefined ? params[i] : ''
            );
          }
        }
        retour = label;
      }
    }
    return retour;
  };
  /**
   * get label for the key and current lang
   * @param key
   * @param params
   * @returns
   */
  public getForLang = (
    key: string,
    lang: string
  ): string => {
    let retour: string = key;
    const localesForLang: any = this.locales[lang];
    if (localesForLang) {
      const label: string = localesForLang[key];
      if (label) {
        retour = label;
      }
    }
    return retour;
  };
}

export const i18n = new I18n();
