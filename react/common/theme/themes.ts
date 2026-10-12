/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ThemeDefinition, ThemeImageKey } from './types'
import { defaultImages } from './themeImages'

class ThemeRegistry {
  private themes: Map<string, ThemeDefinition> = new Map()
  private images: Record<ThemeImageKey, string> = { ...defaultImages }

  constructor() {
    // No built-in themes registered here.
    // Each app registers its own themes via themeRegistry.register() at startup
    // (see front/src/themes/index.ts or equivalent).
  }

  register(theme: ThemeDefinition): void {
    this.themes.set(theme.id, theme)
  }

  get(id: string): ThemeDefinition | undefined {
    return this.themes.get(id)
  }

  getAll(): ThemeDefinition[] {
    return Array.from(this.themes.values())
  }

  getDefault(): ThemeDefinition {
    return this.themes.get('default')!
  }

  /** Override the global default image set (called by each app at startup). */
  setDefaultImages(overrides: Partial<Record<ThemeImageKey, string>>): void {
    this.images = { ...defaultImages, ...overrides }
  }

  /** Resolve an image key: theme override → app default → global default. */
  resolveImage(key: ThemeImageKey, activeThemeId?: string): string {
    const theme = activeThemeId ? this.themes.get(activeThemeId) : undefined
    return theme?.images?.[key] ?? this.images[key] ?? defaultImages[key]
  }
}

export const themeRegistry = new ThemeRegistry()
