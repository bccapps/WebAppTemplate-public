/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, vi } from 'vitest';
import { createWebPushSessionTracker, webPushActionOnSessionChange } from './webPushSession';

describe('webPushActionOnSessionChange', () => {
  it('drops the subscription when the user who had it leaves (logout, session end, another account)', () => {
    expect(webPushActionOnSessionChange(1, null)).toBe('unsubscribe');
    expect(webPushActionOnSessionChange(1, 2)).toBe('unsubscribe');
    expect(webPushActionOnSessionChange('u-1', 'u-2')).toBe('unsubscribe');
  });

  it('keeps it otherwise (same user, a login, nobody before)', () => {
    expect(webPushActionOnSessionChange(1, 1)).toBe('keep');
    expect(webPushActionOnSessionChange(1, '1')).toBe('keep');
    expect(webPushActionOnSessionChange(null, 3)).toBe('keep');
    expect(webPushActionOnSessionChange(null, null)).toBe('keep');
  });
});

describe('createWebPushSessionTracker', () => {
  it('unsubscribes once per departure, never on a reload or a re-render of the same user, and never throws', async () => {
    const unsubscribe = vi.fn(async () => {
      throw new Error('the back refused it after the logout');
    });
    const tracker = createWebPushSessionTracker(unsubscribe, 7);
    expect(tracker.observe(7)).toBe('keep');
    expect(tracker.observe(7)).toBe('keep');
    expect(tracker.observe(null)).toBe('unsubscribe');
    expect(tracker.observe(null)).toBe('keep');
    expect(tracker.observe(8)).toBe('keep');
    expect(tracker.observe(9)).toBe('unsubscribe');
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
