/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { DynamicModule, Type } from '@nestjs/common';
import type { AuthCoreOptions } from '../auth/AuthCoreModule';

/** A module registered at the root of the app. */
export type PluginModule = Type<unknown> | DynamicModule;

/**
 * Factory for a module whose `forRoot` needs input only the app can give (ports, classes). It receives
 * `pluginOptions[<plugin id>]` (`back/src/config/pluginOptions.ts`) and must throw `PluginOptionsError`
 * (see `requirePluginOptions`) when a required option is missing.
 */
export type PluginModuleFactory<TOptions = never> = (options: TOptions) => DynamicModule;

/** Descriptor exported as `plugin` by `<module>/plugin.ts`, consumed by the generated plugins file of the app. */
export interface NestModulePlugin<TOptions = never> {
  id: string;
  /** Module to add to AppModule.imports, or a factory building it from the app's options for this plugin. */
  module?: PluginModule | PluginModuleFactory<TOptions>;
  /** Further modules to add (a folder exposing several Nest modules). Registered right after `module`. */
  modules?: PluginModule[];
  /** Registration order among plugins: lower first. Default 100; ties keep the order of shared-modules.json. */
  order?: number;
  /** At most one linked plugin may provide auth; it replaces the anonymous provider. */
  auth?: AuthCoreOptions;
}

/** Options of the app, by plugin id (`back/src/config/pluginOptions.ts`). */
export type PluginOptions = Record<string, unknown>;

/** Default value of `NestModulePlugin.order`. */
export const DEFAULT_PLUGIN_ORDER = 100;
