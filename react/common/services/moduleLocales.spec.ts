/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from 'vitest';
import { mergeModuleLocales } from './moduleLocales';

describe('mergeModuleLocales', () => {
  it('groups the files by language, reading the default export or the bare module', () => {
    const merged = mergeModuleLocales({
      '/src/modules_shared/common/locales/locales.en.json': { default: { 'common.a': 'A' } },
      '/src/modules_shared/common/locales/locales.fr.json': { default: { 'common.a': 'A fr' } },
      '/src/modules_shared/user/locales/locales.en.json': { 'user.b': 'B' },
    });
    expect(merged).toEqual({ en: { 'common.a': 'A', 'user.b': 'B' }, fr: { 'common.a': 'A fr' } });
  });

  it('lets the later path override the earlier one on the same key, whatever the input order', () => {
    const merged = mergeModuleLocales({
      '/src/modules_shared/zeta/locales/locales.en.json': { default: { k: 'zeta' } },
      '/src/modules_shared/alpha/locales/locales.en.json': { default: { k: 'alpha', only: 'x' } },
    });
    expect(merged.en).toEqual({ k: 'zeta', only: 'x' });
  });

  it('ignores files that are not locales.<lang>.json', () => {
    expect(mergeModuleLocales({ '/src/modules_shared/x/locales/readme.json': { default: { a: 'b' } } })).toEqual({});
  });
});
