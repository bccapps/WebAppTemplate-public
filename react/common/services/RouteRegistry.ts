/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export type RouteRegistryEntry = {
  value: string;
  label: string;
};

/**
 * No built-in routes registered here. Each app registers its own routes
 * (from its Router.tsx) via `routeRegistry.register()` at startup. Lets
 * shared-module admin config fields (ConfigFieldSchema with
 * `dynamicOptionsKey`) offer a select of app routes without the shared
 * module knowing the app's route table.
 */
class RouteRegistry {
  private groups: Map<string, RouteRegistryEntry[]> = new Map();

  register(groupKey: string, entries: RouteRegistryEntry[]): void {
    this.groups.set(groupKey, entries);
  }

  get(groupKey: string): RouteRegistryEntry[] {
    return this.groups.get(groupKey) ?? [];
  }
}

export const routeRegistry = new RouteRegistry();
