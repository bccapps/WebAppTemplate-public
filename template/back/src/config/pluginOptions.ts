/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { PluginOptions } from 'src/modules_shared/common/plugins/NestModulePlugin';

/**
 * Options of the linked plugins whose module is a factory (`NestModulePlugin.module: (options) => DynamicModule`),
 * by plugin id: the ports and classes only this app can provide. Empty by default: most plugins need none.
 * A plugin whose options are missing makes the app fail at startup with the plugin id and the missing keys.
 *
 * Example: `export const pluginOptions: PluginOptions = { 'wallet-intelligence-client': { heldTokensPort: MyPort } };`
 */
export const pluginOptions: PluginOptions = {};
