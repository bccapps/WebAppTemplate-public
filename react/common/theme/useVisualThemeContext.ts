/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { createContext, useContext } from 'react'
import type { ThemeDefinition } from './types'

export type VisualThemeContextValue = {
  activeTheme: ThemeDefinition
  availableThemes: ThemeDefinition[]
  setTheme: (id: string) => void
  isEnabled: boolean
}

/** Provided by `VisualThemeProvider`. */
export const VisualThemeContext = createContext<VisualThemeContextValue | undefined>(undefined)

/** Active visual theme and selectable themes of the enclosing `VisualThemeProvider`. */
export function useVisualThemeContext(): VisualThemeContextValue {
  const ctx = useContext(VisualThemeContext)
  if (!ctx) throw new Error('useVisualThemeContext must be used within VisualThemeProvider')
  return ctx
}
