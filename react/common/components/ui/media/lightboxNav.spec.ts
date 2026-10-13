/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { describe, it, expect } from 'vitest';
import { clampIndex, counterText, lightboxKeyAction, stepIndex } from './lightboxNav';

describe('lightboxKeyAction', () => {
  it('maps arrows and ignores the rest', () => {
    expect(lightboxKeyAction('ArrowLeft')).toBe('previous');
    expect(lightboxKeyAction('ArrowRight')).toBe('next');
    expect(lightboxKeyAction('Escape')).toBeNull();
    expect(lightboxKeyAction('a')).toBeNull();
  });
});

describe('stepIndex', () => {
  it('moves within the list', () => {
    expect(stepIndex(1, 3, 'next')).toBe(2);
    expect(stepIndex(1, 3, 'previous')).toBe(0);
  });
  it('does not wrap at the edges', () => {
    expect(stepIndex(2, 3, 'next')).toBeNull();
    expect(stepIndex(0, 3, 'previous')).toBeNull();
    expect(stepIndex(0, 0, 'next')).toBeNull();
  });
});

describe('clampIndex / counterText', () => {
  it('keeps the index valid after the list shrinks', () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(2, 0)).toBe(0);
  });
  it('shows a 1-based counter', () => {
    expect(counterText(0, 12)).toBe('1 / 12');
    expect(counterText(11, 12)).toBe('12 / 12');
  });
});
