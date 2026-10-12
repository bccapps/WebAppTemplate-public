/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from 'vitest';
import { collectPlugins, type AppPlugin } from './AppPlugin';

describe('collectPlugins', () => {
  it('filters out modules without plugin and sorts by order', () => {
    const a: AppPlugin = { id: 'a', order: 50 };
    const b: AppPlugin = { id: 'b', order: 10 };
    const c: AppPlugin = { id: 'c' };
    const result = collectPlugins({
      './x/plugin.tsx': { plugin: a },
      './y/plugin.tsx': {},
      './z/plugin.tsx': { plugin: b },
      './w/plugin.tsx': { plugin: c },
    });
    expect(result.map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('keeps declaration order for equal order values', () => {
    const result = collectPlugins({ x: { plugin: { id: 'x', order: 1 } }, y: { plugin: { id: 'y', order: 1 } } });
    expect(result.map((p) => p.id)).toEqual(['x', 'y']);
  });

  it('returns an empty list when nothing exposes a plugin', () => {
    expect(collectPlugins({})).toEqual([]);
  });
});
