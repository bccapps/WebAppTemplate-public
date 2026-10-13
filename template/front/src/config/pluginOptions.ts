/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { PluginOptions } from '@/modules_shared/common/plugins/AppPlugin';

/**
 * Options of the linked front plugins that export a factory (`export const plugin = (options) => AppPlugin`), by plugin id
 * (the module folder). Empty by default: most plugins need none. Example: `{ user: { walletMode: 'lazy' } }`.
 * A factory with missing required options stops the app at startup with the plugin id and the missing keys.
 */
export const pluginOptions: PluginOptions = {};
