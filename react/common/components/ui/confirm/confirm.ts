/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { confirmQueue } from './confirmQueue';
import type { ConfirmOptions } from './confirmQueue';

/**
 * Asks the user to confirm: `if (await confirm({ titleId: 'x.delete.title', danger: true })) ...`.
 * `<ConfirmHost />` must be mounted once in the app shell.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return confirmQueue.enqueue(options);
}
