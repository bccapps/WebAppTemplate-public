/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ThemeDefinition } from '@/modules_shared/common/theme/types'
// No CSS — the default theme relies entirely on the app's :root CSS vars (colors.css).
// data-theme="default" has no matching CSS rules, so :root wins.

export const defaultTheme: ThemeDefinition = {
  id: 'default',
  name: 'common.theme.default.name',
  description: 'common.theme.default.description',
  shell: 'standard',
  interaction: 'standard',
  builtIn: true,
}
