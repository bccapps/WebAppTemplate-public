/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it } from 'vitest';
import { parseAmountInput } from './amountInput';

describe('parseAmountInput', () => {
  it('accepts a plain positive amount', () => {
    expect(parseAmountInput('12.5')).toBe(12.5);
  });

  it('accepts a comma decimal separator', () => {
    expect(parseAmountInput('12,5')).toBe(12.5);
  });

  it('rejects an empty or blank string', () => {
    expect(parseAmountInput('')).toBeNull();
    expect(parseAmountInput('   ')).toBeNull();
  });

  it('rejects zero or a negative amount', () => {
    expect(parseAmountInput('0')).toBeNull();
    expect(parseAmountInput('-5')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(parseAmountInput('abc')).toBeNull();
  });
});
