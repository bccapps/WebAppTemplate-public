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
import { RequireVoiceOwnerInterceptor } from './RequireVoiceOwnerInterceptor';

const ctx = (req: object) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;
const handler = { handle: jest.fn().mockReturnValue('next') } as unknown as CallHandler;

describe('RequireVoiceOwnerInterceptor', () => {
  const i = new RequireVoiceOwnerInterceptor();

  it('rejects an anonymous request and the admin-token identity', () => {
    expect(() => i.intercept(ctx({}), handler)).toThrow('Unauthorized');
    expect(() => i.intercept(ctx({ user: { id: 0, admin: true, kind: 'admin-token' } }), handler)).toThrow('Unauthorized');
  });

  it('rejects the plain local-trust principal (id 0: nobody to own an access)', () => {
    expect(() => i.intercept(ctx({ user: { id: 0, admin: true, kind: 'local-trust' } }), handler)).toThrow('Unauthorized');
    expect(() => i.intercept(ctx({ user: { id: -1, admin: true, kind: 'local-trust' } }), handler)).toThrow('Unauthorized');
    expect(() => i.intercept(ctx({ user: { id: 1.5, admin: true, kind: 'local-trust' } }), handler)).toThrow('Unauthorized');
  });

  it('accepts a user, and the local-trust principal of a desktop that gave its local person a user row', () => {
    expect(i.intercept(ctx({ user: { id: 7, admin: false, kind: 'user' } }), handler)).toBe('next');
    expect(i.intercept(ctx({ user: { id: 1, admin: true, kind: 'local-trust' } }), handler)).toBe('next');
  });
});
