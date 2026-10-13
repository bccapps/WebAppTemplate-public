/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


/** Width/height ratio of a poster; 16/9 when the size is unknown or invalid. */
export function posterAspectRatio(width?: number | null, height?: number | null): number {
  return width && height && width > 0 && height > 0 ? width / height : 16 / 9;
}
