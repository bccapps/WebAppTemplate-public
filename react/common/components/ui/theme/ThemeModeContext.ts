/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { createContext, useContext } from 'react';

export type ThemeMode = 'light' | 'dark';

export interface ThemeModeContextValue {
  mode: ThemeMode;
  toggleMode: () => void;
  setMode: (mode: ThemeMode) => void;
  themeCode: string;
  setThemeCode: (code: string) => void;
}

/** Provided by `ThemeModeProvider`. */
export const ThemeModeContext = createContext<ThemeModeContextValue | undefined>(undefined);

/** Light/dark mode and custom theme code of the enclosing `ThemeModeProvider`. */
export function useThemeMode(): ThemeModeContextValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) {
    throw new Error('useThemeMode must be used within ThemeModeProvider');
  }
  return ctx;
}
