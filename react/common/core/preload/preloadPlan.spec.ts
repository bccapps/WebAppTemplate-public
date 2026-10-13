/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from 'vitest';
import { buildPreloadPlan, withPreloadKey } from './preloadPlan';

const svc = (name: string) => ({ name });

describe('buildPreloadPlan', () => {
  it('splits blocking (default) and background entries and sets the preload keys', () => {
    const [a, b, c] = [svc('a'), svc('b'), svc('c')];
    const plan = buildPreloadPlan(
      [{ key: 'A', service: a }],
      [{ id: 'p', preload: [{ key: 'B', service: b, mode: 'background' }, { key: 'C', service: c, mode: 'blocking' }] }],
    );
    expect(plan.blocking).toEqual([a, c]);
    expect(plan.background).toEqual([b]);
    expect((b as { preloadKey?: string }).preloadKey).toBe('B');
  });

  it('lets an app remove a core service by not listing it, and keeps the first declaration of a key', () => {
    const crypt = svc('crypt');
    const first = svc('first');
    const second = svc('second');
    const withoutCrypt = buildPreloadPlan([], [{ id: 'p', preload: [{ key: 'K', service: first }, { key: 'K', service: second, mode: 'background' }] }]);
    expect(withoutCrypt.blocking).toEqual([first]);
    expect(withoutCrypt.background).toEqual([]);
    expect(crypt).not.toBe(first);
  });

  it('accepts plugins without preload', () => {
    expect(buildPreloadPlan([], [{ id: 'p' }])).toEqual({ blocking: [], background: [] });
  });
});

describe('withPreloadKey', () => {
  it('returns the same service with its key', () => {
    const s = svc('x');
    expect(withPreloadKey(s, 'K')).toBe(s);
    expect((s as { preloadKey?: string }).preloadKey).toBe('K');
  });
});
