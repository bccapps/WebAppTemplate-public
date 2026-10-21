/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ThemeDefinition } from './types'
import { visualThemeService } from './VisualThemeService'
import { themeRegistry } from './themes'
import { VisualThemeContext, type VisualThemeContextValue } from './useVisualThemeContext'

export function VisualThemeProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<ThemeDefinition>(() => {
    // init() reads localStorage + applies data-theme attribute synchronously.
    // Safe to call here because configurationService is already loaded
    // (VisualThemeProvider sits inside PreloaderGate).
    visualThemeService.init()
    return visualThemeService.getActive()
  })
  const isEnabled = visualThemeService.isEnabled()

  useEffect(() => {
    return visualThemeService.subscribe((theme) => setActive(theme))
  }, [])

  const setTheme = useCallback((id: string) => {
    visualThemeService.setTheme(id)
  }, [])

  const value = useMemo<VisualThemeContextValue>(
    () => ({
      activeTheme: active,
      availableThemes: themeRegistry.getSelectable(),
      setTheme,
      isEnabled,
    }),
    [active, setTheme, isEnabled],
  )

  return <VisualThemeContext.Provider value={value}>{children}</VisualThemeContext.Provider>
}
