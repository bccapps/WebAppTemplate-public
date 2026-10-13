/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { createElement, lazy, type ReactElement } from 'react';
import type { AppPlugin, PluginRoute, RouteLayout } from './AppPlugin';

/** Overrides of plugin routes by path: `false` removes the route, an object replaces its fields (`element`/`lazy`, `guard`, `layout`). */
export type PluginRouteOverrides = Record<string, false | Partial<PluginRoute>>;

export interface ResolvedRoute {
  path: string;
  element: ReactElement;
  layout: RouteLayout;
  /** Plugin id, or `app` for the routes of the app itself. */
  source: string;
}

export class RouteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteConfigError';
  }
}

interface Candidate {
  route: PluginRoute;
  source: string;
  defaultLayout: RouteLayout;
}

function applyOverride(candidate: Candidate, overrides: PluginRouteOverrides): Candidate | null {
  if (candidate.source === 'app') return candidate;
  const override = overrides[candidate.route.path];
  if (override === undefined) return candidate;
  if (override === false) return null;
  const replacesContent = override.element !== undefined || override.lazy !== undefined;
  const merged = { ...candidate.route, ...override };
  if (replacesContent) {
    // the override brings its own content: drop the other form of the original route
    if (override.element === undefined) delete (merged as { element?: unknown }).element;
    if (override.lazy === undefined) delete (merged as { lazy?: unknown }).lazy;
  }
  return { ...candidate, route: merged as PluginRoute };
}

function buildElement(route: PluginRoute): ReactElement {
  if ((route.element === undefined) === (route.lazy === undefined)) {
    throw new RouteConfigError(`Route "${route.path}" must define exactly one of "element" or "lazy"`);
  }
  const content = route.element ?? createElement(lazy(route.lazy as NonNullable<PluginRoute['lazy']>));
  return route.guard ? createElement(route.guard, null, content) : content;
}

function candidatesOf(appRoutes: ReadonlyArray<PluginRoute>, plugins: ReadonlyArray<AppPlugin>): Candidate[] {
  return [
    ...appRoutes.map((route) => ({ route, source: 'app', defaultLayout: 'page' as RouteLayout })),
    ...plugins.flatMap((plugin) => [
      ...(plugin.routes ?? []).map((route) => ({ route, source: plugin.id, defaultLayout: 'page' as RouteLayout })),
      ...(plugin.adminRoutes ?? []).map((route) => ({ route, source: plugin.id, defaultLayout: 'admin' as RouteLayout })),
    ]),
  ];
}

export interface ResolveRoutesInput {
  /** Routes of the app itself (they cannot be overridden: edit them). */
  appRoutes?: ReadonlyArray<PluginRoute>;
  plugins: ReadonlyArray<AppPlugin>;
  overrides?: PluginRouteOverrides;
  /** Dev: a duplicated path throws `RouteConfigError`. Otherwise it is logged and the first route wins. */
  strict?: boolean;
}

/**
 * The final route table: app routes, then the routes and adminRoutes of the plugins in order, after the app's overrides
 * (`front/src/config/pluginRoutes.ts`). Lazy routes become `React.lazy` elements (render them inside a `Suspense`), guards
 * wrap the element. A path declared twice is an error in dev: remove the override target or the duplicate, or override it
 * by path in `pluginRoutes.ts`.
 */
export function resolveRoutes({ appRoutes = [], plugins, overrides = {}, strict = false }: ResolveRoutesInput): ResolvedRoute[] {
  const seen = new Map<string, string>();
  const resolved: ResolvedRoute[] = [];
  for (const raw of candidatesOf(appRoutes, plugins)) {
    const candidate = applyOverride(raw, overrides);
    if (!candidate) continue;
    const { route, source, defaultLayout } = candidate;
    const owner = seen.get(route.path);
    if (owner !== undefined) {
      const message = `Duplicate route "${route.path}" (declared by "${owner}" and "${source}"); override it in front/src/config/pluginRoutes.ts`;
      if (strict) throw new RouteConfigError(message);
      console.error(message);
      continue;
    }
    seen.set(route.path, source);
    resolved.push({ path: route.path, element: buildElement(route), layout: route.layout ?? defaultLayout, source });
  }
  return resolved;
}
