/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from '@jest/globals';
import { authUserId, extractBearerToken } from './authRequest';
import { SecurityException } from '../exceptions/SecurityException';

describe('authUserId', () => {
  it('returns the id of the authenticated principal', () => {
    expect(authUserId({ user: { id: 42, admin: false, kind: 'user' } })).toBe(42);
  });

  it('throws a 401 SecurityException without a principal', () => {
    expect(() => authUserId({})).toThrow(SecurityException);
    expect(() => authUserId(undefined)).toThrow(SecurityException);
    expect(() => authUserId({ user: { id: '42' } })).toThrow(SecurityException);
  });
});

describe('extractBearerToken', () => {
  it('reads the token of an Authorization: Bearer header', () => {
    expect(extractBearerToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
    expect(extractBearerToken({ headers: {} })).toBeNull();
  });
});
