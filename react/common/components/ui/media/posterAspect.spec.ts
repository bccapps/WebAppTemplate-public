/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { describe, it, expect } from 'vitest';
import { posterAspectRatio } from './posterAspect';

describe('posterAspectRatio', () => {
  it('uses the real size when known, else 16/9', () => {
    expect(posterAspectRatio(1280, 720)).toBeCloseTo(16 / 9);
    expect(posterAspectRatio(512, 768)).toBeCloseTo(2 / 3);
    expect(posterAspectRatio(null, null)).toBeCloseTo(16 / 9);
    expect(posterAspectRatio(0, 10)).toBeCloseTo(16 / 9);
  });
});
