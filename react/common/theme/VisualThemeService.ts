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
import { commandRegistry } from './commands/CommandRegistry'
import { configurationService } from '../services/ConfigurationService'

const STORAGE_KEY = 'vx_visual_theme'

type ChangeListener = (theme: ThemeDefinition) => void

class VisualThemeService {
  private listeners: Set<ChangeListener> = new Set()
  private active: ThemeDefinition | null = null
  private injectedFonts: Set<string> = new Set()

  /**
   * Call once at app boot (after configurationService is ready).
   * Reads saved theme from localStorage, applies it.
   */
  init(): void {
    const saved = this.readSaved()
    const theme = themeRegistry.get(saved) ?? themeRegistry.getDefault()
    this.applyTheme(theme, false)
  }

  /** Whether the theming system is enabled (config flag). */
  isEnabled(): boolean {
    const val = configurationService.get('common_themes_enabled')
    // Default is true — only disabled when explicitly set to false
    return val !== false && val !== 'false'
  }

  getActive(): ThemeDefinition {
    return this.active ?? themeRegistry.getDefault()
  }

  setTheme(id: string): void {
    const theme = themeRegistry.get(id) ?? themeRegistry.getDefault()
    this.applyTheme(theme, true)
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private applyTheme(theme: ThemeDefinition, persist: boolean): void {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme.id)
    }

    this.loadFonts(theme)
    this.syncCommands(theme)

    this.active = theme

    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, theme.id) } catch { /* ignore */ }
    }

    this.listeners.forEach((fn) => fn(theme))
  }

  private loadFonts(theme: ThemeDefinition): void {
    if (!theme.fonts || typeof document === 'undefined') return
    theme.fonts.forEach(({ url }) => {
      if (!url || this.injectedFonts.has(url)) return
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = url
      document.head.appendChild(link)
      this.injectedFonts.add(url)
    })
  }

  private syncCommands(theme: ThemeDefinition): void {
    commandRegistry.clearThemeCommands()
    if (theme.commands) {
      commandRegistry.registerThemeCommands(theme.commands)
    }
  }

  private readSaved(): string {
    try { return localStorage.getItem(STORAGE_KEY) ?? 'default' } catch { return 'default' }
  }
}

export const visualThemeService = new VisualThemeService()
