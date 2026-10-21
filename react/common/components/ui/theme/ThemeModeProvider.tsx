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
        primary: { main: getCssVar('--accent-strong', '#1fcb7d') },
        secondary: { main: getCssVar('--color-primary-strong', isDark ? '#24d996' : '#0f794d') },
        background: {
          default: getCssVar('--color-bg', isDark ? '#111418' : '#f2f3f5'),
          paper: getCssVar('--color-surface', isDark ? '#181c22' : '#ffffff'),
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
              backgroundColor: getCssVar('--color-bg', isDark ? '#111418' : '#f2f3f5'),
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
