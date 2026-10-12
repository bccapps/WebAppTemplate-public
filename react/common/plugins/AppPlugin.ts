/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ComponentType, ElementType, ReactElement, ReactNode } from 'react';

/** Same shape as the entries consumed by `PreloaderGate` (`services`). */
export interface PreloadEntry {
  key: string;
  service: unknown;
}

export interface PluginRoute {
  path: string;
  element: ReactElement;
}

export interface AdminMenuItem {
  id: string;
  labelId: string;
  to: string;
  icon: ElementType;
}

export interface AdminMenuSection {
  id: string;
  labelId: string;
  items: AdminMenuItem[];
}

export interface AppPlugin {
  id: string;
  /** Ascending; Providers wrap from the lowest (outermost) to the highest. */
  order?: number;
  preload?: PreloadEntry[];
  /** May render a boot loader until ready. */
  Provider?: ComponentType<{ children: ReactNode }>;
  /** Rendered at the right end of the header. */
  HeaderActions?: ComponentType;
  routes?: PluginRoute[];
  adminRoutes?: PluginRoute[];
  adminMenu?: AdminMenuSection[];
}

const DEFAULT_ORDER = 100;

/** Keep the modules exposing a `plugin` export, sorted by ascending `order` (stable). */
export function collectPlugins(modules: Record<string, { plugin?: AppPlugin }>): AppPlugin[] {
  return Object.values(modules)
    .map((mod) => mod?.plugin)
    .filter((plugin): plugin is AppPlugin => Boolean(plugin))
    .map((plugin, index) => ({ plugin, index }))
    .sort((a, b) => (a.plugin.order ?? DEFAULT_ORDER) - (b.plugin.order ?? DEFAULT_ORDER) || a.index - b.index)
    .map(({ plugin }) => plugin);
}
