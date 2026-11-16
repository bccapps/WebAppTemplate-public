/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from 'vitest';
import { canUseInteraction } from './interactionAccess';

describe('canUseInteraction', () => {
  it('never offers interactions to a visitor', () => {
    expect(canUseInteraction({ isAuth: false, isAdmin: false, allowUsers: true })).toBe(false);
  });

  it('always offers them to an admin', () => {
    expect(canUseInteraction({ isAuth: true, isAdmin: true, allowUsers: false })).toBe(true);
    expect(canUseInteraction({ isAuth: true, isAdmin: true, allowUsers: '' })).toBe(true);
  });

  it('offers them to other users only when the switch is on (off when absent or not a boolean true)', () => {
    expect(canUseInteraction({ isAuth: true, isAdmin: false, allowUsers: true })).toBe(true);
    expect(canUseInteraction({ isAuth: true, isAdmin: false, allowUsers: false })).toBe(false);
    expect(canUseInteraction({ isAuth: true, isAdmin: false, allowUsers: '' })).toBe(false);
    expect(canUseInteraction({ isAuth: true, isAdmin: false, allowUsers: undefined })).toBe(false);
  });
});
