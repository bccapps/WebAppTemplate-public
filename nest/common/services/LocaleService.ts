/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import fs from 'fs';
import path from 'path';
import { FunctionalException } from '../exceptions/FunctionalException';

@Injectable()
export class LocaleService {
  private resolveLocaleDirectories(): { legacyPath: string; moduleLocaleDirs: string[] } {
    const isDist = __dirname.includes(`${path.sep}dist${path.sep}`);
    // Source mode: the module lives under `<back>/.libs/...` whatever the layout depth
    // (`.libs/nestcommon/<m>` legacy, `.libs/vx-public/nest/<m>` new) — anchor on the closest `.libs`.
    const libsMarker = `${path.sep}.libs${path.sep}`;
    const libsIndex = __dirname.lastIndexOf(libsMarker);
    const sourceModeRoot = libsIndex >= 0 ? __dirname.slice(0, libsIndex) : path.resolve(__dirname, '../../../..');
    const baseRoot = isDist ? path.resolve(__dirname, '../../..') : sourceModeRoot;
    const sourceRoot = isDist ? path.resolve(baseRoot, '..', 'src') : path.join(baseRoot, 'src');

    const legacyPrimary = path.join(baseRoot, 'locales');
    const legacyFallback = path.join(sourceRoot, 'locales');
    const legacyPath = fs.existsSync(legacyPrimary) ? legacyPrimary : legacyFallback;

    const rootsToScan = [
      path.join(baseRoot, 'modules'),
      path.join(baseRoot, 'modules_shared'),
      path.join(sourceRoot, 'modules'),
      path.join(sourceRoot, 'modules_shared')
    ];

    const moduleLocaleDirs: string[] = [];
    rootsToScan.forEach((moduleLocalesRoot) => {
      if (!fs.existsSync(moduleLocalesRoot)) return;
      const modules = fs
        .readdirSync(moduleLocalesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink());
      modules.forEach((dir) => {
        const candidate = path.join(moduleLocalesRoot, dir.name, 'locales');
        if (fs.existsSync(candidate) && !moduleLocaleDirs.includes(candidate)) {
          moduleLocaleDirs.push(candidate);
        }
      });
    });

    return { legacyPath, moduleLocaleDirs };
  }

  private collectLocaleFiles(paths: string[], filter?: (filename: string) => boolean): string[] {
    const files: string[] = [];
    paths.forEach((p) => {
      if (!fs.existsSync(p)) return;
      fs.readdirSync(p)
        .filter((fn) => (filter ? filter(fn) : true))
        .forEach((fn) => files.push(path.join(p, fn)));
    });
    return files;
  }

  private buildLocalePayload(files: string[], all=false): Record<string, Record<string, any>> {
    const locale: Record<string, Record<string, any>> = {};
    files.forEach((filePath) => {
      const file = path.basename(filePath);
      const [category, lang] = file.split('.');
      if (!category || !lang) return;
      const rawdata: any = fs.readFileSync(filePath, 'utf-8');
      if (!all) {
        if (!locale[category]) {
          locale[category] = {};
        }
        locale[category][lang] = { ...locale[category][lang], ...JSON.parse(rawdata) };
      } else {
        // Add JSON.parse(rawdata) to existing locale[lang]
        locale[lang] = locale[lang] || {};
        locale[lang] = { ...locale[lang], ...JSON.parse(rawdata) };
      }
    });
    return locale;
  }

  /**
   * get locale of app for the given cateogry
   * @returns
   */
  async getLocale(category: string): Promise<any> {
    const { legacyPath, moduleLocaleDirs } = this.resolveLocaleDirectories();
    const pathsToScan = [legacyPath, ...moduleLocaleDirs];
    const files = this.collectLocaleFiles(pathsToScan, (fn) => fn.startsWith(category + '.'));

    if (!files || files.length == 0) {
      throw new FunctionalException('LOC', 'Locale category not found');
    }
    const locale = this.buildLocalePayload(files);
    return locale[category];
  }

  /**
   * All locales, merged across the legacy `locales/` tree and every module's own
   * `locales/` directory. Memoized for `ALL_LOCALES_CACHE_TTL_MS` — this used to
   * re-scan 4 directory roots and `readFileSync` + `JSON.parse` every one of the
   * ~345 KB of locale files on *every* HTTP call (see PERFORMANCE_PLAN.md §1.3).
   * `clearAllLocalesCache()` forces an early refresh (e.g. after a locale file is
   * edited at runtime); otherwise the cache self-expires after the TTL.
   *
   * @param lang When given, only that language's payload is returned (still keyed
   * by language, e.g. `{ fr: {...} }`) — the frontend never needs more than the
   * active language before an explicit language switch, so this roughly halves
   * the payload for a 2-language app without touching the cached, merged shape.
   */
  async getAllLocales(lang?: string): Promise<Record<string, Record<string, any>>> {
    const payload = await this.getCachedAllLocalesPayload();
    if (!lang) return payload;
    return payload[lang] ? { [lang]: payload[lang] } : {};
  }

  private async getCachedAllLocalesPayload(): Promise<Record<string, Record<string, any>>> {
    const now = Date.now();
    if (this.allLocalesCache && this.allLocalesCache.expiresAt > now) {
      return this.allLocalesCache.payload;
    }
    const { legacyPath, moduleLocaleDirs } = this.resolveLocaleDirectories();
    const legacyFiles = this.collectLocaleFiles([legacyPath], (fn) =>
      fn.startsWith('common.') || fn.startsWith('custom.')
    );
    const moduleFiles = this.collectLocaleFiles(moduleLocaleDirs);
    const files = [...legacyFiles, ...moduleFiles];

    if (!files.length) {
      throw new FunctionalException('LOC', 'No locales found');
    }

    const payload = this.buildLocalePayload(files, true);
    this.allLocalesCache = { payload, expiresAt: now + LocaleService.ALL_LOCALES_CACHE_TTL_MS };
    return payload;
  }

  /** Forces the next `getAllLocales()` call to re-read locale files from disk. */
  clearAllLocalesCache(): void {
    this.allLocalesCache = null;
  }

  private allLocalesCache: { payload: Record<string, Record<string, any>>; expiresAt: number } | null = null;
  private static readonly ALL_LOCALES_CACHE_TTL_MS = 5 * 60 * 1000;

  /**
   * Server-side translation of a single key.
   *
   * Needed by anything the backend renders for a human rather than for the
   * frontend to translate — e-mail bodies above all. Every lookup would
   * otherwise re-read the whole locale tree from disk, so the flattened payload
   * is cached; call `clearTranslationCache()` if locale files change at runtime.
   *
   * Returns the key itself when no translation exists, deliberately: a missing
   * string must be visible so it gets fixed, not silently replaced by a
   * plausible default.
   */
  async translate(key: string, lang: string, params?: (string | number)[]): Promise<string> {
    if (!this.translationCache) {
      this.translationCache = await this.getAllLocales();
    }
    const dictionary = this.translationCache[lang] ?? this.translationCache[Object.keys(this.translationCache)[0]] ?? {};
    const raw = dictionary[key];
    if (typeof raw !== 'string') return key;
    if (!params?.length) return raw;
    return params.reduce<string>((text, value, index) => text.split(`{${index}}`).join(String(value)), raw);
  }

  clearTranslationCache(): void {
    this.translationCache = null;
  }

  private translationCache: Record<string, Record<string, any>> | null = null;
}
