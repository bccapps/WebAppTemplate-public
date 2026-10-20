/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ThemeDefinition } from '../../theme/types'

// No CSS: the shared default theme relies on the token contract (theme/tokens.css) and on the app's own :root vars.

const defaultTheme: ThemeDefinition = {
  id: 'default',
  name: 'common.theme.default.name',
  description: 'common.theme.default.description',
  shell: 'standard',
  interaction: 'standard',
  builtIn: true,
}

export default defaultTheme
