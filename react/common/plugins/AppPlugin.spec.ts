/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  collectPlugins,
  pluginIdFromModuleKey,
  PluginOptionsError,
  requirePluginOptions,
  type AppPlugin,
  type AppPluginFactory,
} from './AppPlugin';

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

describe('collectPlugins with factories', () => {
  it('calls a factory with the options of its module folder and sorts like any plugin', () => {
    const factory = vi.fn((options: { flag?: boolean } | undefined): AppPlugin => ({ id: 'wallet', order: options?.flag ? 1 : 200 }));
    const result = collectPlugins(
      { './modules_shared/wallet/plugin.tsx': { plugin: factory }, './modules_shared/b/plugin.tsx': { plugin: { id: 'b' } } },
      { wallet: { flag: true } },
    );
    expect(factory).toHaveBeenCalledWith({ flag: true });
    expect(result.map((p) => p.id)).toEqual(['wallet', 'b']);
  });

  it('passes undefined when the app gave no options, and prefers an explicit pluginId', () => {
    const seen: unknown[] = [];
    const factory: AppPluginFactory<{ a: number }> = (options) => {
      seen.push(options);
      return { id: 'x' };
    };
    factory.pluginId = 'custom';
    collectPlugins({ './modules_shared/other/plugin.tsx': { plugin: factory } }, { other: { a: 1 } });
    collectPlugins({ './modules_shared/other/plugin.tsx': { plugin: factory } }, { custom: { a: 2 } });
    expect(seen).toEqual([undefined, { a: 2 }]);
  });

  it('keeps plugins that are plain objects untouched (legacy shape)', () => {
    const plugin: AppPlugin = { id: 'user', order: 10 };
    expect(collectPlugins({ './modules_shared/user/plugin.tsx': { plugin } })[0]).toBe(plugin);
  });
});

describe('pluginIdFromModuleKey', () => {
  it('extracts the module folder, or returns the key', () => {
    expect(pluginIdFromModuleKey('./modules_shared/commerce/plugin.tsx')).toBe('commerce');
    expect(pluginIdFromModuleKey('x')).toBe('x');
  });
});

describe('requirePluginOptions', () => {
  it('returns the options when complete', () => {
    const options = { a: 1, b: 2 };
    expect(requirePluginOptions('p', options, ['a', 'b'])).toBe(options);
  });

  it('names the plugin and the missing keys', () => {
    expect(() => requirePluginOptions('p', { a: 1 } as { a: number; b?: number }, ['a', 'b'])).toThrow(PluginOptionsError);
    expect(() => requirePluginOptions('p', undefined, ['a'])).toThrow(/Plugin "p" needs options.*missing: a/);
  });
});
