/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { RateLimitedLog } from './rateLimitedLog';

describe('RateLimitedLog', () => {
  let clock = 0;
  const make = () => {
    const lines: string[] = [];
    const log = new RateLimitedLog({ name: 'test', perWindow: 3, windowMs: 60_000, write: (l) => lines.push(l), now: () => clock });
    return { log, lines };
  };
  afterEach(() => {
    jest.useRealTimers();
    clock = 0;
  });

  it('writes the quota of a category, counts the rest, and keeps categories apart', () => {
    const { log, lines } = make();
    const written = Array.from({ length: 10 }, (_, i) => log.log('413', `line ${i}`));
    expect(written).toEqual([true, true, true, false, false, false, false, false, false, false]);
    expect(log.log('400', 'other category')).toBe(true);
    expect(lines).toEqual(['line 0', 'line 1', 'line 2', 'other category']);
    log.flush();
  });

  it('writes the count of suppressed lines when the next window starts, then the new quota', () => {
    const { log, lines } = make();
    for (let i = 0; i < 8; i += 1) log.log('413', `a${i}`);
    clock = 60_000;
    expect(log.log('413', 'b0')).toBe(true);
    expect(lines).toEqual(['a0', 'a1', 'a2', 'test: 5 more "413" line(s) suppressed (at most 3 per 60 s)', 'b0']);
    log.flush();
  });

  it('flushes the count by itself at the end of the window when nothing else comes', () => {
    jest.useFakeTimers();
    const { log, lines } = make();
    for (let i = 0; i < 5; i += 1) log.log('415', `c${i}`);
    expect(lines).toHaveLength(3);
    jest.advanceTimersByTime(60_000);
    expect(lines[3]).toBe('test: 2 more "415" line(s) suppressed (at most 3 per 60 s)');
    log.flush();
    expect(lines).toHaveLength(4);
  });
});
