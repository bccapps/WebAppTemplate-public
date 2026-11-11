/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it, vi } from 'vitest';
import { appPathOf, openAppPath } from './navigation';

describe('appPathOf', () => {
  it('accepts relative paths of the app only', () => {
    expect(appPathOf('/interaction?tab=inbox')).toBe('/interaction?tab=inbox');
    for (const bad of [null, undefined, '', 'interaction', 'https://evil.test/x', '//evil.test/x', '/\\evil.test', 'javascript:alert(1)', '/a\nb']) expect(appPathOf(bad)).toBeNull();
  });
});

describe('openAppPath', () => {
  it('navigates through the injected function, never for a foreign link', () => {
    const navigate = vi.fn();
    expect(openAppPath('/messages/3', navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/messages/3');
    navigate.mockClear();
    expect(openAppPath('https://evil.test', navigate)).toBe(false);
    expect(openAppPath(null, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
