/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Side-effect: registers all app themes with the ThemeRegistry singleton.
// Imported once at startup (main.tsx) before VisualThemeProvider mounts.

import { themeRegistry } from '@/modules_shared/common/theme/themes'
import { defaultTheme } from './default'

themeRegistry.register(defaultTheme)
