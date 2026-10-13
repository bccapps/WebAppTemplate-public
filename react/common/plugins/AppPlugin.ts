/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ComponentType, ElementType, ReactElement, ReactNode } from 'react';

/** `blocking` (default): the app waits for the service. `background`: started after the configuration, never awaited. */
export type PreloadMode = 'blocking' | 'background';

/** Same shape as the entries consumed by `PreloaderGate` (`services`), plus the loading mode. */
export interface PreloadEntry {
  key: string;
  service: unknown;
  mode?: PreloadMode;
}

/** `page`: header, sidebar, footer. `admin`: like `page`, the sidebar adds the admin menu. `fullscreen`: no chrome. */
export type RouteLayout = 'page' | 'fullscreen' | 'admin';

/** Wraps a route element and decides whether to render it (`RequireAdmin`, `RequireAuth`, `RequireFeature(id)`, or your own). */
export type RouteGuard = ComponentType<{ children: ReactNode }>;

interface PluginRouteBase {
  path: string;
  guard?: RouteGuard;
  /** Default: `page` for `routes`, `admin` for `adminRoutes`. */
  layout?: RouteLayout;
}

/** A route has exactly one of `element` (eager) or `lazy` (code-split, rendered inside the router `Suspense`). */
export type PluginRoute =
  | (PluginRouteBase & { element: ReactElement; lazy?: undefined })
  | (PluginRouteBase & { lazy: () => Promise<{ default: ComponentType }>; element?: undefined });

/** What a menu predicate may look at. `hasFeature` is always true while no feature system (the `user` plugin) is active. */
export interface MenuContext {
  isAdmin: boolean;
  isAuth: boolean;
  hasFeature: (featureId: string) => boolean;
}

export interface MenuItem {
  id: string;
  labelId: string;
  to: string;
  icon: ElementType;
  /** Hidden when it returns false (default: visible). */
  visible?: (ctx: MenuContext) => boolean;
}

export interface MenuSection {
  id: string;
  labelId: string;
  items: MenuItem[];
}

/** @deprecated Former names, kept for plugins written before `navMenu`. */
export type AdminMenuItem = MenuItem;
/** @deprecated Former name of `MenuSection`. */
export type AdminMenuSection = MenuSection;

/** Props received by a plugin `HeaderActions`. */
export interface HeaderActionsProps {
  isAuth: boolean;
  isAdmin: boolean;
}

export interface AppPlugin {
  id: string;
  /** Ascending; Providers wrap from the lowest (outermost) to the highest. */
  order?: number;
  preload?: PreloadEntry[];
  /** May render a boot loader until ready (use `preload` with `mode: 'background'` for slow, non-essential services). */
  Provider?: ComponentType<{ children: ReactNode }>;
  /** `outer` (default): around the theme, router and preloader. `inner`: inside all of them (config loaded, router and theme available). */
  providerPlacement?: 'outer' | 'inner';
  /** Rendered at the end of the header (see `PluginHeaderActions`). */
  HeaderActions?: ComponentType<HeaderActionsProps>;
  routes?: PluginRoute[];
  /** Same as `routes` with the `admin` layout by default. */
  adminRoutes?: PluginRoute[];
  /** Entries of the sidebar for every visitor (filtered by `visible`). */
  navMenu?: MenuSection[];
  /** Entries of the sidebar on `admin` layout pages, admins only. */
  adminMenu?: MenuSection[];
}

/** Options the app gives to a plugin factory, by plugin id (`front/src/config/pluginOptions.ts`). */
export type PluginOptions = Record<string, Record<string, unknown> | undefined>;

/** A module may export a factory instead of a plugin when it needs options from the app. */
export type AppPluginFactory<TOptions = Record<string, unknown>> = ((options: TOptions | undefined) => AppPlugin) & {
  /** Key of the options; default: folder of the module (`./modules_shared/<id>/plugin.tsx`). */
  pluginId?: string;
};

export type PluginExport = AppPlugin | AppPluginFactory<never>;

export class PluginOptionsError extends Error {
  constructor(pluginId: string, missing: string[]) {
    super(`Plugin "${pluginId}" needs options in front/src/config/pluginOptions.ts (missing: ${missing.join(', ')})`);
    this.name = 'PluginOptionsError';
  }
}

/** For a factory: throw a clear error when the app did not provide the required options. */
export function requirePluginOptions<T extends Record<string, unknown>>(
  pluginId: string,
  options: T | undefined,
  requiredKeys: ReadonlyArray<keyof T & string>,
): T {
  const missing = requiredKeys.filter((key) => options?.[key] === undefined || options?.[key] === null);
  if (!options || missing.length > 0) throw new PluginOptionsError(pluginId, missing.length > 0 ? missing : [...requiredKeys]);
  return options;
}

const DEFAULT_ORDER = 100;

/** `./modules_shared/<id>/plugin.tsx` -> `<id>`; any other key is used as is. */
export function pluginIdFromModuleKey(key: string): string {
  return /(?:^|\/)([^/]+)\/plugin\.[tj]sx?$/.exec(key)?.[1] ?? key;
}

function instantiate(key: string, exported: PluginExport, options: PluginOptions): AppPlugin {
  if (typeof exported !== 'function') return exported;
  const factory = exported as AppPluginFactory<Record<string, unknown>>;
  return factory(options[factory.pluginId ?? pluginIdFromModuleKey(key)]);
}

/**
 * Keep the modules exposing a `plugin` export (an `AppPlugin` or a factory fed by `options[<plugin id>]`),
 * sorted by ascending `order` (stable: ties keep the order of `modules`).
 */
export function collectPlugins(
  modules: Record<string, { plugin?: PluginExport }>,
  options: PluginOptions = {},
): AppPlugin[] {
  return Object.entries(modules)
    .filter(([, mod]) => Boolean(mod?.plugin))
    .map(([key, mod], index) => ({ plugin: instantiate(key, mod.plugin as PluginExport, options), index }))
    .sort((a, b) => (a.plugin.order ?? DEFAULT_ORDER) - (b.plugin.order ?? DEFAULT_ORDER) || a.index - b.index)
    .map(({ plugin }) => plugin);
}
