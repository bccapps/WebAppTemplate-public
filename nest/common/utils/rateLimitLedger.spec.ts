/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import {
  applyRateLimitLedgerUsage,
  isUnderRateLimitLedger,
  RateLimitLedgerCeiling,
  RateLimitLedgerState,
  RateLimitLedgerWindow,
  rollRateLimitLedger,
} from './rateLimitLedger';

const MINUTE = { name: 'minute', kind: 'rolling', windowMs: 60_000 } as const satisfies RateLimitLedgerWindow;
const DAY = { name: 'day', kind: 'calendar-day' } as const satisfies RateLimitLedgerWindow;
const WINDOWS: readonly RateLimitLedgerWindow[] = [MINUTE, DAY];
const CEILINGS: readonly RateLimitLedgerCeiling[] = [
  { window: 'minute', counter: 'requests', limit: 5 },
  { window: 'day', counter: 'requests', limit: 20 },
  { window: 'minute', counter: 'tokens', limit: 1000 },
];

describe('rateLimitLedger', () => {
  it('rolls a never-started ledger into fresh, empty windows', () => {
    const rolled = rollRateLimitLedger({}, WINDOWS, Date.now());
    expect(rolled.minute.counters).toEqual({});
    expect(rolled.day.counters).toEqual({});
  });

  it('accumulates usage across calls without resetting inside the window', () => {
    const now = Date.now();
    let state = applyRateLimitLedgerUsage({}, WINDOWS, now, { requests: 1, tokens: 100 });
    state = applyRateLimitLedgerUsage(state, WINDOWS, now + 1000, { requests: 1, tokens: 50 });
    expect(state.minute.counters).toEqual({ requests: 2, tokens: 150 });
    expect(state.day.counters).toEqual({ requests: 2, tokens: 150 });
  });

  it('resets the rolling window once windowMs has elapsed, but keeps the calendar-day window', () => {
    const now = Date.now();
    let state = applyRateLimitLedgerUsage({}, WINDOWS, now, { requests: 3, tokens: 300 });
    state = applyRateLimitLedgerUsage(state, WINDOWS, now + 61_000, { requests: 1, tokens: 10 });
    expect(state.minute.counters).toEqual({ requests: 1, tokens: 10 });
    expect(state.day.counters).toEqual({ requests: 4, tokens: 310 });
  });

  it('resets the calendar-day window exactly at a UTC-day boundary, independent of elapsed ms', () => {
    const beforeMidnight = new Date('2026-01-01T23:59:59.000Z').getTime();
    const afterMidnight = new Date('2026-01-02T00:00:01.000Z').getTime();
    let state = applyRateLimitLedgerUsage({}, WINDOWS, beforeMidnight, { requests: 1, tokens: 1 });
    state = applyRateLimitLedgerUsage(state, WINDOWS, afterMidnight, { requests: 1, tokens: 1 });
    // Only 2 seconds elapsed, far under the 60s rolling window, so the minute counter keeps accruing...
    expect(state.minute.counters).toEqual({ requests: 2, tokens: 2 });
    // ...but the day counter resets because the UTC calendar date changed.
    expect(state.day.counters).toEqual({ requests: 1, tokens: 1 });
  });

  it('reports headroom true when under every ceiling', () => {
    const now = Date.now();
    const state: RateLimitLedgerState = applyRateLimitLedgerUsage({}, WINDOWS, now, { requests: 2, tokens: 200 });
    expect(isUnderRateLimitLedger(state, WINDOWS, CEILINGS, now, { requests: 1, tokens: 100 }, 0)).toBe(true);
  });

  it('reports headroom false once a ceiling would be exceeded', () => {
    const now = Date.now();
    const state = applyRateLimitLedgerUsage({}, WINDOWS, now, { requests: 5, tokens: 0 });
    expect(isUnderRateLimitLedger(state, WINDOWS, CEILINGS, now, { requests: 1, tokens: 0 }, 0)).toBe(false);
  });

  it('applies a safety margin so headroom runs out before the real ceiling', () => {
    const now = Date.now();
    const state = applyRateLimitLedgerUsage({}, WINDOWS, now, { requests: 4, tokens: 0 });
    // 4 used, limit 5, no margin: 1 more still fits.
    expect(isUnderRateLimitLedger(state, WINDOWS, CEILINGS, now, { requests: 1, tokens: 0 }, 0)).toBe(true);
    // Same state, 20% margin: effective ceiling is 4, already at 4 -> no more headroom.
    expect(isUnderRateLimitLedger(state, WINDOWS, CEILINGS, now, { requests: 1, tokens: 0 }, 20)).toBe(false);
  });

  it('a null limit never blocks, regardless of usage', () => {
    const now = Date.now();
    const unboundedCeilings: readonly RateLimitLedgerCeiling[] = [{ window: 'minute', counter: 'requests', limit: null }];
    const state = applyRateLimitLedgerUsage({}, WINDOWS, now, { requests: 999 });
    expect(isUnderRateLimitLedger(state, WINDOWS, unboundedCeilings, now, { requests: 1 }, 0)).toBe(true);
  });

  it('leaves a counter absent from amounts untouched on that call', () => {
    const now = Date.now();
    let state = applyRateLimitLedgerUsage({}, WINDOWS, now, { requests: 1, tokens: 100 });
    // A subsequent call reports no token count (e.g. a streaming response) — tokens must not move.
    state = applyRateLimitLedgerUsage(state, WINDOWS, now, { requests: 1 });
    expect(state.minute.counters).toEqual({ requests: 2, tokens: 100 });
  });
});
