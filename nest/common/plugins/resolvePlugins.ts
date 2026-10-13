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

/** Name of the class behind a plugin module (a class, or the `module` of a dynamic module). */
function moduleClassName(module: PluginModule): string {
  return 'module' in module ? module.module.name : module.name;
}

/** Reads the app's entry for a plugin: `false` disables it, `{ excludeModules }` filters its modules. */
function splitOptions(entry: unknown): { disabled: boolean; exclude: string[]; rest: unknown } {
  if (entry === false) return { disabled: true, exclude: [], rest: undefined };
  if (typeof entry !== 'object' || entry === null || !('excludeModules' in entry)) return { disabled: false, exclude: [], rest: entry };
  const { excludeModules, ...rest } = entry as { excludeModules?: unknown } & Record<string, unknown>;
  const exclude = Array.isArray(excludeModules) ? (excludeModules as string[]) : [];
  return { disabled: false, exclude, rest };
}

/**
 * Modules of one plugin: `module` (built by its factory when it is one), then `modules`.
 * `options[id] === false` disables the plugin; `options[id].excludeModules` removes modules by class name (an unknown name is
 * an error); the factory receives the options without that key.
 */
export function pluginModules(plugin: NestModulePlugin<never>, options: PluginOptions = {}): PluginModule[] {
  const { disabled, exclude, rest } = splitOptions(options[plugin.id]);
  if (disabled) return [];
  const result: PluginModule[] = [];
  if (plugin.module) {
    result.push(isFactory(plugin.module) ? plugin.module(rest as never) : plugin.module);
  }
  return filterModules(plugin.id, result.concat(plugin.modules ?? []), exclude);
}

function filterModules(pluginId: string, modules: PluginModule[], exclude: string[]): PluginModule[] {
  if (!exclude.length) return modules;
  const names = modules.map(moduleClassName);
  const unknown = exclude.filter((name) => !names.includes(name));
  if (unknown.length) {
    throw new Error(
      `Plugin "${pluginId}": excludeModules names no module of this plugin (${unknown.join(', ')}); its modules are: ${names.join(', ')}`,
    );
  }
  return modules.filter((module) => !exclude.includes(moduleClassName(module)));
}

/** A Nest module class is a function too: tell it from a factory by its `class` source (targets are ES2017+). */
function isFactory(module: NonNullable<NestModulePlugin<never>['module']>): module is PluginModuleFactory<never> {
  return typeof module === 'function' && !/^class[\s{]/.test(Function.prototype.toString.call(module));
}

/** Every module to import in AppModule, in registration order, for the given app options. */
export function resolvePluginModules(plugins: readonly NestModulePlugin<never>[], options: PluginOptions = {}): PluginModule[] {
  return sortPlugins(plugins).flatMap((plugin) => pluginModules(plugin, options));
}
