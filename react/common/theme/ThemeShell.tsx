/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useVisualTheme } from './hooks/useVisualTheme'
import { StandardShell } from './shells/StandardShell'
import { TerminalShell } from './shells/TerminalShell'

type ThemeShellProps = {
  children: React.ReactNode
  /** Passed to TerminalShell for the titlebar label. */
  appName?: string
}

/**
 * ThemeShell — dispatcher that renders the appropriate shell component
 * based on the active theme's `shell` property.
 *
 * Place this as the outermost wrapper inside BrowserRouter / ThemeModeProvider:
 *
 * ```tsx
 * <ThemeModeProvider>
 *   <VisualThemeProvider>
 *     <BrowserRouter>
 *       <ThemeShell appName="MyApp">
 *         <RouterOutlet />
 *       </ThemeShell>
 *     </BrowserRouter>
 *   </VisualThemeProvider>
 * </ThemeModeProvider>
 * ```
 */
export function ThemeShell({ children, appName }: ThemeShellProps) {
  const { activeTheme } = useVisualTheme()

  switch (activeTheme.shell) {
    case 'terminal':
      return <TerminalShell appName={appName}>{children}</TerminalShell>
    case 'standard':
    default:
      return <StandardShell>{children}</StandardShell>
  }
}
