/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
// Thin wrapper kept for apps that still call `node scripts/link-shared.mjs`:
// delegates to the shared script (scripts/link-shared.mjs at the template root).
import { linkShared } from '../../scripts/link-shared.mjs';
await linkShared('back', process.cwd());
