/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ThemeImageKey } from '../types'
import { themeRegistry } from '../themes'
import { useVisualTheme } from './useVisualTheme'

/**
 * Returns the URL for a themed image.
 * Resolution order: theme override → app default → built-in default.
 *
 * @example
 * const logoUrl = useThemeImage('logoMain')
 * return <img src={logoUrl} />
 */
export function useThemeImage(key: ThemeImageKey): string {
  const { activeTheme } = useVisualTheme()
  return themeRegistry.resolveImage(key, activeTheme.id)
}
