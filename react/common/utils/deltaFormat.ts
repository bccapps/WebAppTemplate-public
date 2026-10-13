/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Formats a percentage delta as `+1.2%` / `-3.4%`, or an em dash when unavailable. */
export function formatDelta(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

/** MUI palette path for a delta: green when positive, red when negative, muted otherwise. */
export function deltaColor(value: number | null): 'success.main' | 'error.main' | 'text.secondary' {
  if (value === null || Number.isNaN(value) || value === 0) return 'text.secondary';
  return value > 0 ? 'success.main' : 'error.main';
}
