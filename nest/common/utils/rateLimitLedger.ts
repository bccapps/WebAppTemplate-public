/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Generic PROACTIVE rate-limit ledger: rolls one or more named windows (a sliding duration, or a
 * UTC-calendar-day boundary) and checks/accumulates one or more named counters within them,
 * BEFORE a call is made — so a caller can steer away from an about-to-be-exhausted budget
 * instead of only reacting to the 429 it would otherwise cause.
 *
 * Generalized out of llm-proxy's original RPM/RPD/TPM/TPD ledger (llmProxyRateLimitUtils.ts),
 * which now delegates to this file — see that module for the LLM-specific wrapper. Any future
 * API integration with a documented "N requests per minute/day" (or similar) free-tier quota can
 * use this directly instead of re-deriving the same window/reset math.
 *
 * A `null` ceiling always means "unknown", never "zero" — every check here is a no-op (always
 * passes) on a counter with no declared limit, so an axis without a documented figure behaves as
 * if unbounded.
 */

export interface RateLimitLedgerWindow {
  /** Unique key for this window within one ledger definition, e.g. 'minute' or 'day'. */
  readonly name: string;
  /**
   * 'rolling': resets `windowMs` after this window's own last reset (a sliding TTL, not aligned
   * to a fixed grid). 'calendar-day': resets at UTC midnight regardless of when it last reset —
   * `windowMs` is ignored.
   */
  readonly kind: 'rolling' | 'calendar-day';
  readonly windowMs?: number;
}

export interface RateLimitLedgerCeiling {
  /** Must match a `RateLimitLedgerWindow.name` in the same definition. */
  readonly window: string;
  /** Arbitrary counter name scoped to that window, e.g. 'requests' or 'tokens'. */
  readonly counter: string;
  readonly limit: number | null;
}

interface RateLimitLedgerWindowState {
  boundaryKey: string | null;
  counters: Record<string, number>;
}

/** Opaque, JSON-serializable state — persist it verbatim between calls (e.g. as DB columns or a single jsonb field). */
export type RateLimitLedgerState = Record<string, RateLimitLedgerWindowState>;

/** UTC calendar day as `YYYY-MM-DD`. */
export function utcDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function currentBoundaryKey(window: RateLimitLedgerWindow, nowMs: number): string {
  return window.kind === 'calendar-day' ? utcDayString(new Date(nowMs)) : String(nowMs);
}

function isWindowExpired(window: RateLimitLedgerWindow, state: RateLimitLedgerWindowState, nowMs: number): boolean {
  if (state.boundaryKey === null) return true;
  if (window.kind === 'calendar-day') return state.boundaryKey !== utcDayString(new Date(nowMs));
  const windowMs = window.windowMs ?? 0;
  return nowMs - Number(state.boundaryKey) >= windowMs;
}

/**
 * Recomputes every window, resetting counters whose boundary has expired. Pure — never reads or
 * writes anything external. Callers persist the returned state themselves.
 */
export function rollRateLimitLedger(
  state: RateLimitLedgerState,
  windows: readonly RateLimitLedgerWindow[],
  nowMs: number,
): RateLimitLedgerState {
  const rolled: RateLimitLedgerState = {};
  for (const window of windows) {
    const current = state[window.name] ?? { boundaryKey: null, counters: {} };
    rolled[window.name] = isWindowExpired(window, current, nowMs)
      ? { boundaryKey: currentBoundaryKey(window, nowMs), counters: {} }
      : current;
  }
  return rolled;
}

/**
 * True when, after virtually rolling expired windows, every declared ceiling still has headroom
 * for `amounts[ceiling.counter]` more under `limit * (1 - marginPct/100)` — evaluated with a
 * safety margin so a caller can move on BEFORE the real 429 rather than after. Pure — does not
 * mutate `state`.
 */
export function isUnderRateLimitLedger(
  state: RateLimitLedgerState,
  windows: readonly RateLimitLedgerWindow[],
  ceilings: readonly RateLimitLedgerCeiling[],
  nowMs: number,
  amounts: Readonly<Record<string, number>>,
  marginPct: number,
): boolean {
  const rolled = rollRateLimitLedger(state, windows, nowMs);
  const margin = Math.max(0, Math.min(100, marginPct)) / 100;
  return ceilings.every((ceiling) => {
    if (ceiling.limit === null) return true;
    const used = rolled[ceiling.window]?.counters[ceiling.counter] ?? 0;
    const addition = amounts[ceiling.counter] ?? 0;
    return used + addition <= ceiling.limit * (1 - margin);
  });
}

/**
 * Applies one call's usage on top of the rolled windows — returns the new state to persist. Only
 * counters named in `amounts` are touched (per window); a counter absent from `amounts` for a
 * given call (e.g. no token count on a failed/streaming call) is left untouched, matching the
 * original ledger's behavior of advancing request counters even when a companion metric is 0/unknown.
 */
export function applyRateLimitLedgerUsage(
  state: RateLimitLedgerState,
  windows: readonly RateLimitLedgerWindow[],
  nowMs: number,
  amounts: Readonly<Record<string, number>>,
): RateLimitLedgerState {
  const rolled = rollRateLimitLedger(state, windows, nowMs);
  const applied: RateLimitLedgerState = {};
  for (const window of windows) {
    const current = rolled[window.name];
    const counters = { ...current.counters };
    for (const [counter, amount] of Object.entries(amounts)) {
      counters[counter] = (counters[counter] ?? 0) + Math.max(0, amount);
    }
    applied[window.name] = { boundaryKey: current.boundaryKey, counters };
  }
  return applied;
}
