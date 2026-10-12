/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Reads a positive-integer query param from the current URL, or null if absent/malformed. */
export const readIntUrlParam = (name: string): number | null => {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
};
