/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  DEFAULT_PLUGIN_ORDER,
  type NestModulePlugin,
  type PluginModule,
  type PluginModuleFactory,
  type PluginOptions,
} from './NestModulePlugin';

/** Raised at startup when a plugin factory needs options the app did not provide. */
export class PluginOptionsError extends Error {
  constructor(pluginId: string, missing: string[] = []) {
    const detail = missing.length ? ` (missing: ${missing.join(', ')})` : '';
    super(
      `Plugin "${pluginId}" needs options${detail}: export them under the key "${pluginId}" ` +
        'of back/src/config/pluginOptions.ts',
    );
    this.name = 'PluginOptionsError';
  }
}

/**
 * Checks that the app provided the options of a plugin and the listed keys; returns them typed.
 * Meant to be called by a plugin factory (`module: (o) => XModule.forRoot(requirePluginOptions('x', o, ['port']))`).
 */
export function requirePluginOptions<T extends object>(pluginId: string, options: T | undefined, required: (keyof T & string)[] = []): T {
  if (options === undefined || options === null) throw new PluginOptionsError(pluginId, required);
  const missing = required.filter((key) => options[key] === undefined || options[key] === null);
  if (missing.length) throw new PluginOptionsError(pluginId, missing);
  return options;
}

/** Plugins sorted by `order` (default 100); the sort is stable, so ties keep the input order. */
export function sortPlugins<T extends NestModulePlugin<never>>(plugins: readonly T[]): T[] {
  return plugins
    .map((plugin, index) => ({ plugin, index }))
    .sort((a, b) => (a.plugin.order ?? DEFAULT_PLUGIN_ORDER) - (b.plugin.order ?? DEFAULT_PLUGIN_ORDER) || a.index - b.index)
    .map(({ plugin }) => plugin);
}

/** Modules of one plugin: `module` (built by its factory when it is one), then `modules`. */
export function pluginModules(plugin: NestModulePlugin<never>, options: PluginOptions = {}): PluginModule[] {
  const result: PluginModule[] = [];
  if (plugin.module) {
    result.push(isFactory(plugin.module) ? plugin.module(options[plugin.id] as never) : plugin.module);
  }
  return result.concat(plugin.modules ?? []);
}

/** A Nest module class is a function too: tell it from a factory by its `class` source (targets are ES2017+). */
function isFactory(module: NonNullable<NestModulePlugin<never>['module']>): module is PluginModuleFactory<never> {
  return typeof module === 'function' && !/^class[\s{]/.test(Function.prototype.toString.call(module));
}

/** Every module to import in AppModule, in registration order, for the given app options. */
export function resolvePluginModules(plugins: readonly NestModulePlugin<never>[], options: PluginOptions = {}): PluginModule[] {
  return sortPlugins(plugins).flatMap((plugin) => pluginModules(plugin, options));
}
