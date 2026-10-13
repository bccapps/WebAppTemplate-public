/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { describe, it, expect } from 'vitest';
import { classifyMicError } from './useMicRecorder';

describe('classifyMicError', () => {
  it('maps permission refusals', () => {
    expect(classifyMicError({ name: 'NotAllowedError' })).toBe('denied');
    expect(classifyMicError({ name: 'SecurityError' })).toBe('denied');
  });
  it('maps a missing device', () => {
    expect(classifyMicError({ name: 'NotFoundError' })).toBe('no-device');
  });
  it('falls back to a generic error', () => {
    expect(classifyMicError(new Error('boom'))).toBe('error');
    expect(classifyMicError(null)).toBe('error');
    expect(classifyMicError('x')).toBe('error');
  });
});
