/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from 'vitest';
import { infoTipAriaLabel, resolveHelp, resolveText } from './helpText';
import type { Translate } from './helpText';

const translate: Translate = (key, params) => `[${key}${params ? ':' + params.join(',') : ''}]`;

describe('resolveText', () => {
  it('prefers the i18n key over the literal text', () => {
    expect(resolveText('k', 'raw', translate)).toBe('[k]');
  });
  it('falls back to the literal text, then to undefined', () => {
    expect(resolveText(undefined, 'raw', translate)).toBe('raw');
    expect(resolveText(undefined, undefined, translate)).toBeUndefined();
  });
});

describe('resolveHelp', () => {
  it('resolves title, body and tip from keys', () => {
    expect(resolveHelp({ titleId: 't', bodyId: 'b', tipId: 'c' }, translate)).toEqual({
      title: '[t]',
      body: '[b]',
      tip: '[c]',
    });
  });
  it('keeps a literal or rich body when no key is given', () => {
    expect(resolveHelp({ title: 'T', body: 'B' }, translate)).toEqual({ title: 'T', body: 'B', tip: undefined });
  });
});

describe('infoTipAriaLabel', () => {
  it('names the help after its title', () => {
    expect(infoTipAriaLabel({ title: 'Seed' }, translate)).toBe('[common.ui.infoTip.labelWithTitle:Seed]');
  });
  it('uses a generic name without a title', () => {
    expect(infoTipAriaLabel({ body: 'x' }, translate)).toBe('[common.ui.infoTip.label]');
  });
});
