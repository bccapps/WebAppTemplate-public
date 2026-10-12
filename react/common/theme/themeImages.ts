/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ThemeImageKey } from './types'

/**
 * Default image paths — apps override these by providing their own defaults
 * via ThemeRegistry.setDefaultImages().
 */
export const defaultImages: Record<ThemeImageKey, string> = {
  logoMain: '/images/logo.svg',
  logoSmall: '/images/logo-small.svg',
  heroBackground: '',
  favicon: '/favicon.ico',
}
