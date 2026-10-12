/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { RequireAuthInterceptor } from './RequireAuthInterceptor';
import { RequireUserInterceptor } from './RequireUserInterceptor';

const ctx = (req: object) =>
  ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;
const handler = { handle: jest.fn().mockReturnValue('next') } as unknown as CallHandler;

describe('RequireUserInterceptor', () => {
  const i = new RequireUserInterceptor();
  it('rejects when req.user is absent', () => {
    expect(() => i.intercept(ctx({}), handler)).toThrow('Unauthorized');
  });
  it('rejects the admin-token principal', () => {
    expect(() => i.intercept(ctx({ user: { id: 0, admin: true, kind: 'admin-token' } }), handler)).toThrow('Unauthorized');
  });
  it('accepts a user', () => {
    expect(i.intercept(ctx({ user: { id: 1, admin: false, kind: 'user' } }), handler)).toBe('next');
  });
});

describe('RequireAuthInterceptor', () => {
  const i = new RequireAuthInterceptor();
  it('rejects when req.user is absent', () => {
    expect(() => i.intercept(ctx({}), handler)).toThrow('Unauthorized');
  });
  it('accepts admin-token and user', () => {
    expect(i.intercept(ctx({ user: { id: 0, admin: true, kind: 'admin-token' } }), handler)).toBe('next');
    expect(i.intercept(ctx({ user: { id: 1, admin: false, kind: 'user' } }), handler)).toBe('next');
  });
});
