/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { AppPlugin } from './AppPlugin';

let registered: AppPlugin[] = [];

/** Called once by the app's `plugins.ts`, so components of `react/common` (e.g. `PluginHeaderActions`) can reach the plugins. */
export function registerAppPlugins(plugins: AppPlugin[]): void {
  registered = plugins;
}

export function getAppPlugins(): AppPlugin[] {
  return registered;
}
