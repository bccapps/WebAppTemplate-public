/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

/**
 * Reconnection delay after `failures` consecutive failures (0 = first retry): 1 s, 2 s, 4 s ... capped at 30 s, with
 * a random factor in [0.8, 1.2) so that many tabs do not reconnect in lockstep. `random` returns [0, 1).
 */
export function computeBackoff(failures: number, random: () => number): number {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures), BACKOFF_MAX_MS);
  const jittered = exponential * (0.8 + random() * 0.4);
  return Math.min(Math.round(jittered), BACKOFF_MAX_MS);
}
