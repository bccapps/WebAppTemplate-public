/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { collectPlugins, type AppPlugin, type PluginExport } from '@/modules_shared/common/plugins/AppPlugin';
import { registerAppPlugins } from '@/modules_shared/common/plugins/pluginRegistry';
import { pluginOptions } from '@/config/pluginOptions';

// Every linked shared module exposing a `plugin.tsx` is picked up here (via the modules_shared
// symlinks). Adding/removing a module in shared-modules.json needs no change in App/Router/Header.
// A plugin may be a factory fed by `src/config/pluginOptions.ts`.
const modules = import.meta.glob<{ plugin?: PluginExport }>('./modules_shared/*/plugin.tsx', { eager: true });

export const appPlugins: AppPlugin[] = collectPlugins(modules, pluginOptions);
registerAppPlugins(appPlugins); // lets `PluginHeaderActions` (react/common) reach them from any header
export const userManagementEnabled = appPlugins.some((p) => p.id === 'user');
