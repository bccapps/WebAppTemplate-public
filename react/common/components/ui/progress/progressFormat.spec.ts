/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from 'vitest';
import { computePercent, estimateRemaining, formatBytes, formatClock, formatDuration, formatRate } from './progressFormat';

/** ICU uses narrow/no-break spaces: compare on a plain-space version. */
const plain = (text: string) => text.replace(/\s/g, ' ');

describe('formatBytes', () => {
  it('localizes the unit (binary multiples)', () => {
    expect(plain(formatBytes(1536 * 1024 * 1024, 'en'))).toBe('1.5 GB');
    expect(plain(formatBytes(5 * 1024 * 1024, 'fr'))).toBe('5 Mo');
  });
  it('drops the decimal from 100 and for bytes', () => {
    expect(plain(formatBytes(250 * 1024 * 1024, 'en'))).toBe('250 MB');
    expect(plain(formatBytes(0, 'en'))).toBe('0 byte');
  });
  it('treats negative input as 0', () => {
    expect(plain(formatBytes(-5, 'en'))).toBe('0 byte');
  });
});

describe('formatRate', () => {
  it('appends the per-second unit', () => {
    expect(plain(formatRate(12 * 1024 * 1024, 'fr'))).toBe('12 Mo/s');
    expect(plain(formatRate(3.5 * 1024 * 1024, 'en'))).toBe('3.5 MB/s');
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(plain(formatDuration(42, 'fr'))).toBe('42 s');
    expect(plain(formatDuration(185, 'fr'))).toBe('3 min 05 s');
    expect(plain(formatDuration(3900, 'fr'))).toBe('1 h 05 min');
  });
  it('returns a dash when unknown or infinite', () => {
    expect(formatDuration(null, 'fr')).toBe('—');
    expect(formatDuration(Infinity, 'fr')).toBe('—');
  });
});

describe('formatClock', () => {
  it('pads seconds and switches to hours', () => {
    expect(formatClock(7)).toBe('0:07');
    expect(formatClock(723)).toBe('12:03');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(-4)).toBe('0:00');
  });
});

describe('computePercent', () => {
  it('clamps to 0-100 and is null for an unknown total', () => {
    expect(computePercent(25, 100)).toBe(25);
    expect(computePercent(150, 100)).toBe(100);
    expect(computePercent(5, 0)).toBeNull();
  });
});

describe('estimateRemaining', () => {
  it('uses the given eta first, then the rate, else null', () => {
    expect(estimateRemaining(0, 100, 10, 7)).toBe(7);
    expect(estimateRemaining(50, 100, 10)).toBe(5);
    expect(estimateRemaining(50, 100)).toBeNull();
    expect(estimateRemaining(50, 0, 10)).toBeNull();
  });
});
