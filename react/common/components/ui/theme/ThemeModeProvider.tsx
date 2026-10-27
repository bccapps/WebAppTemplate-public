/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createTheme } from '@mui/material/styles';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { configurationService } from '../../../services/ConfigurationService';
import { ThemeModeContext, type ThemeMode } from './ThemeModeContext';

// Last-resort palette used only when a CSS variable is absent (no theme loaded yet): MUI needs resolved values.
const FALLBACK_PRIMARY = '#1fcb7d'; // theme-colors-ignore: JS last-resort default when --accent-strong is not defined
const FALLBACK_SECONDARY = { dark: '#24d996', light: '#0f794d' }; // theme-colors-ignore: JS last-resort default when --color-primary-strong is not defined
const FALLBACK_BG = { dark: '#111418', light: '#f2f3f5' }; // theme-colors-ignore: JS last-resort default when --color-bg is not defined
const FALLBACK_PAPER = { dark: '#181c22', light: '#ffffff' }; // theme-colors-ignore: JS last-resort default when --color-surface is not defined

const getCssVar = (name: string, fallback: string): string => {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
};

/** Maps keys to the CSS vars that are actually defined; undefined vars are omitted so MUI keeps its default. */
const definedCssVars = (vars: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(vars)
      .map(([key, name]: [string, string]) => [key, getCssVar(name, '')])
      .filter(([, value]: string[]) => value !== ''),
  );

export function ThemeModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('dark');
  const [themeCode, setThemeCodeState] = useState<string>(
    () => localStorage.getItem('selectedTheme') || 'default'
  );

  const setMode = useCallback((m: ThemeMode) => setModeState(m), []);
  const toggleMode = useCallback(() => setModeState(prev => (prev === 'dark' ? 'light' : 'dark')), []);

  const setThemeCode = useCallback(async (code: string) => {
    localStorage.setItem('selectedTheme', code);
    setThemeCodeState(code);
    const existingStyle = document.getElementById('custom-theme');
    if (code === 'default') {
      existingStyle?.remove();
      return;
    }
    try {
      const apiUrl = configurationService.getApiUrl();
      const response = await fetch(apiUrl + '/themes/' + code + '/css');
      if (response.ok) {
        const css = await response.text();
        if (existingStyle) {
          existingStyle.textContent = css;
        } else {
          const style = document.createElement('style');
          style.id = 'custom-theme';
          style.textContent = css;
          document.head.appendChild(style);
        }
      }
    } catch { /* silently fallback to default */ }
  }, []);

  const theme = useMemo(() => {
    const isDark = mode === 'dark';
    // Set data-color-scheme before reading CSS variables so they resolve correctly.
    // Note: data-theme is managed by VisualThemeService for the visual theme selection.
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-color-scheme', mode);
    }
    return createTheme({
      palette: {
        mode,
        primary: { main: getCssVar('--accent-strong', FALLBACK_PRIMARY) },
        secondary: { main: getCssVar('--color-primary-strong', isDark ? FALLBACK_SECONDARY.dark : FALLBACK_SECONDARY.light) },
        background: {
          default: getCssVar('--color-bg', isDark ? FALLBACK_BG.dark : FALLBACK_BG.light),
          paper: getCssVar('--color-surface', isDark ? FALLBACK_PAPER.dark : FALLBACK_PAPER.light),
        },
        ...Object.fromEntries(
          Object.entries(definedCssVars({ error: '--color-danger', success: '--color-success', warning: '--color-warning' }))
            .map(([key, main]: [string, string]) => [key, { main }]),
        ),
        text: definedCssVars({ primary: '--color-text', secondary: '--color-text-muted' }),
        ...definedCssVars({ divider: '--color-border' }),
      },
      components: {
        MuiCssBaseline: {
          styleOverrides: {
            body: {
              backgroundColor: getCssVar('--color-bg', isDark ? FALLBACK_BG.dark : FALLBACK_BG.light),
            },
          },
        },
      },
    });
  }, [mode]);

  const value = useMemo(
    () => ({ mode, toggleMode, setMode, themeCode, setThemeCode }),
    [mode, toggleMode, setMode, themeCode, setThemeCode],
  );

  useEffect(() => {
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      root.setAttribute('data-color-scheme', mode);
    }
  }, [mode]);

  // Apply saved custom theme on mount
  useEffect(() => {
    if (themeCode !== 'default') {
      setThemeCode(themeCode);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ThemeModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}

// Compat: TradeKong and Papang still import the hook from here on their pushed branches (deploys take the latest
// library main). Remove once they import it from ThemeModeContext.
// eslint-disable-next-line react-refresh/only-export-components
export { useThemeMode } from './ThemeModeContext';
