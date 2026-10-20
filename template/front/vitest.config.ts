/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Without this file Vitest falls back to its defaults and also collects the back-end Jest specs of `.libs/*/nest`.
import { createVitestConfig } from './vitestConfig'

export default createVitestConfig()
