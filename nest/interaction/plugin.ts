/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { NestModulePlugin } from '../common/plugins/NestModulePlugin';
import { requirePluginOptions } from '../common/plugins/resolvePlugins';
import { InteractionModule } from './InteractionModule';
import type { InteractionModuleOptions } from './interactionOptions';

/** Options of the plugin: `pluginOptions.interaction` in `back/src/config/pluginOptions.ts` (`directory` required). */
export type InteractionPluginOptions = InteractionModuleOptions;

/**
 * Registered at the app root only (the module is imported by nobody else: consumers inject `UserInteractionService`).
 * `forRoot` needs the app's `InteractionDirectory`, hence a factory.
 */
export const plugin: NestModulePlugin<InteractionPluginOptions> = {
  id: 'interaction',
  module: (options) => InteractionModule.forRoot(requirePluginOptions('interaction', options, ['directory'])),
};
