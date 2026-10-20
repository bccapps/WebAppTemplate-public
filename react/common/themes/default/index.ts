/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ThemeDefinition } from '../../theme/types'

// The default look is the token contract: its values apply while `data-theme='default'` (specificity 0, an app palette wins).
import '../../theme/tokens.css'

const defaultTheme: ThemeDefinition = {
  id: 'default',
  name: 'common.theme.default.name',
  description: 'common.theme.default.description',
  shell: 'standard',
  interaction: 'standard',
  builtIn: true,
}

export default defaultTheme
