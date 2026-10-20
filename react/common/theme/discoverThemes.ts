/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ThemeDefinition } from './types'
import { themeRegistry } from './themes'

type ThemeModule = Record<string, unknown>

/** Shared themes (vx-public): modules_shared/common/themes/<id>/index.ts */
const sharedModules = import.meta.glob<ThemeModule>('../themes/*/index.ts', { eager: true })

/** Private themes (the app's own, never published in vx-public): src/themes/<id>/index.ts */
const localModules = import.meta.glob<ThemeModule>('/src/themes/*/index.ts', { eager: true })

export function isThemeDefinition(value: unknown): value is ThemeDefinition {
  if (typeof value !== 'object' || value === null) return false
  const { id, shell, interaction } = value as Partial<ThemeDefinition>
  return typeof id === 'string' && typeof shell === 'string' && typeof interaction === 'string'
}

/** A theme module exports its definition as default (legacy modules: any named export). */
function definitionOf(mod: ThemeModule): ThemeDefinition | undefined {
  if (isThemeDefinition(mod.default)) return mod.default
  return Object.values(mod).find(isThemeDefinition)
}

/** Definitions of a glob result, in path order. */
export function collectThemes(modules: Record<string, ThemeModule>): ThemeDefinition[] {
  return Object.keys(modules)
    .sort()
    .map((path: string) => definitionOf(modules[path]))
    .filter((theme: ThemeDefinition | undefined): theme is ThemeDefinition => theme !== undefined)
}

/**
 * Registers the shared themes, then the private ones: a private theme with the id of a shared one replaces it.
 * Idempotent (the registry is keyed by id).
 */
export function discoverThemes(): void {
  collectThemes(sharedModules).forEach((theme: ThemeDefinition) => themeRegistry.register(theme))
  collectThemes(localModules).forEach((theme: ThemeDefinition) => themeRegistry.register(theme))
}
