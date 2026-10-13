/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import {
  PluginOptionsError,
  pluginModules,
  requirePluginOptions,
  resolvePluginModules,
  sortPlugins,
} from './resolvePlugins';
import type { NestModulePlugin } from './NestModulePlugin';

@Module({})
class AModule {}
@Module({})
class BModule {}
@Module({})
class CModule {}

const dyn = (name: string): DynamicModule => ({ module: AModule, providers: [{ provide: name, useValue: name }] });

describe('sortPlugins', () => {
  it('sorts by order (default 100) and keeps input order on ties', () => {
    const plugins: NestModulePlugin[] = [{ id: 'a' }, { id: 'b', order: 10 }, { id: 'c', order: 200 }, { id: 'd' }];
    expect(sortPlugins(plugins).map((p) => p.id)).toEqual(['b', 'a', 'd', 'c']);
  });
});

describe('pluginModules', () => {
  it('returns the legacy single module', () => {
    expect(pluginModules({ id: 'a', module: AModule })).toEqual([AModule]);
  });

  it('puts module first, then modules (classes and dynamic modules)', () => {
    const d = dyn('x');
    expect(pluginModules({ id: 'a', module: AModule, modules: [BModule, d] })).toEqual([AModule, BModule, d]);
  });

  it('supports modules without module and plugins without any module', () => {
    expect(pluginModules({ id: 'a', modules: [BModule] })).toEqual([BModule]);
    expect(pluginModules({ id: 'a', auth: undefined })).toEqual([]);
  });

  it('keeps a dynamic module as is', () => {
    const d = dyn('x');
    expect(pluginModules({ id: 'a', module: d })).toEqual([d]);
  });

  it('calls a factory with the options of its plugin id only', () => {
    const received: unknown[] = [];
    const plugin: NestModulePlugin<{ port: string }> = {
      id: 'ports',
      module: (options) => {
        received.push(options);
        return dyn(options.port);
      },
    };
    const out = pluginModules(plugin, { ports: { port: 'p1' }, other: { port: 'no' } });
    expect(received).toEqual([{ port: 'p1' }]);
    expect(out).toEqual([dyn('p1')]);
  });

  it('does not call a Nest module class as a factory', () => {
    expect(pluginModules({ id: 'a', module: CModule }, {})).toEqual([CModule]);
  });

  it('fails clearly when a factory requires options the app did not provide', () => {
    const plugin: NestModulePlugin<{ port?: string }> = {
      id: 'ports',
      module: (options) => dyn(requirePluginOptions('ports', options, ['port']).port as string),
    };
    expect(() => pluginModules(plugin, {})).toThrow(PluginOptionsError);
    expect(() => pluginModules(plugin, {})).toThrow(/"ports".*pluginOptions\.ts/);
    expect(() => pluginModules(plugin, { ports: {} })).toThrow(/missing: port/);
  });
});

describe('requirePluginOptions', () => {
  it('returns the options when complete', () => {
    const opts = { a: 1, b: 2 };
    expect(requirePluginOptions('x', opts, ['a', 'b'])).toBe(opts);
  });
});

describe('resolvePluginModules', () => {
  it('orders modules across plugins', () => {
    const plugins: NestModulePlugin[] = [
      { id: 'late', module: AModule, order: 150 },
      { id: 'multi', module: BModule, modules: [CModule] },
      { id: 'early', module: dyn('e'), order: 1 },
    ];
    expect(resolvePluginModules(plugins)).toEqual([dyn('e'), BModule, CModule, AModule]);
  });
});
