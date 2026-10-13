/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { isProcessAlive, PARENT_PID_ENV, resolveParentPid, watchParentProcess } from './watchParentProcess';

describe('resolveParentPid', () => {
  it('reads a positive integer', () => {
    expect(resolveParentPid({ [PARENT_PID_ENV]: '4242' })).toBe(4242);
    expect(resolveParentPid({ [PARENT_PID_ENV]: ' 7 ' })).toBe(7);
  });
  it('ignores unset, empty, zero and non-numeric values', () => {
    for (const v of [undefined, '', '0', '-3', 'abc', '12x']) expect(resolveParentPid({ [PARENT_PID_ENV]: v })).toBeUndefined();
  });
});

describe('isProcessAlive', () => {
  it('is true for the current process and false for an unused pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe('watchParentProcess', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('calls onGone once when the parent disappears', () => {
    let alive = true;
    const onGone = jest.fn();
    watchParentProcess(1, onGone, { intervalMs: 100, isAlive: () => alive });
    jest.advanceTimersByTime(250);
    expect(onGone).not.toHaveBeenCalled();
    alive = false;
    jest.advanceTimersByTime(1000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('stops watching when asked', () => {
    const onGone = jest.fn();
    const stop = watchParentProcess(1, onGone, { intervalMs: 100, isAlive: () => false });
    stop();
    jest.advanceTimersByTime(1000);
    expect(onGone).not.toHaveBeenCalled();
  });
});
