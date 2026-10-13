/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { AppPlugin, PreloadEntry } from '../../plugins/AppPlugin';

export interface PreloadPlan {
  /** Awaited by the `PreloaderGate` before anything renders. */
  blocking: unknown[];
  /** Started after the configuration, never awaited. */
  background: unknown[];
}

/** Give the service the key the `Preloader` identifies it by (its name in the loading label). */
export function withPreloadKey<T>(service: T, key: string): T {
  (service as { preloadKey?: string }).preloadKey = key;
  return service;
}

/**
 * Merge the core services of the app (`coreServices` in `App.tsx`: remove one there to drop it) with the `preload`
 * entries of the plugins. A key already present wins (first declaration), so a plugin cannot load a service twice.
 */
export function buildPreloadPlan(coreServices: ReadonlyArray<PreloadEntry>, plugins: ReadonlyArray<AppPlugin>): PreloadPlan {
  const plan: PreloadPlan = { blocking: [], background: [] };
  const keys = new Set<string>();
  for (const entry of [...coreServices, ...plugins.flatMap((plugin) => plugin.preload ?? [])]) {
    if (keys.has(entry.key)) continue;
    keys.add(entry.key);
    (entry.mode === 'background' ? plan.background : plan.blocking).push(withPreloadKey(entry.service, entry.key));
  }
  return plan;
}
