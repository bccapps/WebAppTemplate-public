/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useSyncExternalStore } from 'react'
import type { ThemeImageKey } from '../types'
import { themeRegistry } from '../themes'
import { visualThemeService } from '../VisualThemeService'

const subscribe = (onChange: () => void): (() => void) => visualThemeService.subscribe(() => onChange())
const getActiveId = (): string => visualThemeService.getActive().id

/**
 * Returns the URL for a themed image.
 * Resolution order: theme override → app default → built-in default.
 * Reads the service directly (no React context): usable outside VisualThemeProvider, e.g. on the landing page.
 *
 * @example
 * const logoUrl = useThemeImage('logoMain')
 * return <img src={logoUrl} />
 */
export function useThemeImage(key: ThemeImageKey): string {
  const activeId = useSyncExternalStore(subscribe, getActiveId)
  return themeRegistry.resolveImage(key, activeId)
}
