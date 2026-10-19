/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Parses a free-text amount field (comma or dot decimal separator) — `null` when not a usable positive amount. */
export function parseAmountInput(text: string): number | null {
  if (text.trim() === '') return null;
  const parsed = Number(text.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
