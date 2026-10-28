/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from './I18n';

describe('i18n.get placeholders', () => {
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    i18n.add({
      en: {
        twice: 'Install {0} on {1}; {0} is then chosen on {1}.',
        extra: 'Only {0} and {1}.',
        plain: 'No placeholder.',
      },
    });
    i18n.setLang('en', false);
  });

  it('replaces every occurrence of a placeholder', () => {
    expect(i18n.get('twice', ['claude', 'hub'])).toBe('Install claude on hub; claude is then chosen on hub.');
  });

  it('keeps a placeholder with no matching parameter and blanks null/undefined values', () => {
    expect(i18n.get('extra', ['a'])).toBe('Only a and {1}.');
    expect(i18n.get('extra', ['a', null])).toBe('Only a and .');
  });

  it('never re-scans a substituted value nor reads `$` patterns in it', () => {
    expect(i18n.get('extra', ['{1}', '$&'])).toBe('Only {1} and $&.');
  });

  it('returns the label as is without parameters, and the key when it is unknown', () => {
    expect(i18n.get('plain')).toBe('No placeholder.');
    expect(i18n.get('missing_key', ['x'])).toBe('missing_key');
  });
});
