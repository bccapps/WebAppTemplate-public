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
import { Reflector } from '@nestjs/core';
import { SecurityException } from '../exceptions/SecurityException';
import type { AuthPort } from './AuthPort';
import type { AuthPrincipal } from './AuthPrincipal';
import { GlobalAuthInterceptor } from './GlobalAuthInterceptor';

type Req = Record<string, any>;

function build(mode: AuthPort['mode'], principal: AuthPrincipal | null, isPublic = false) {
  const port: AuthPort = { mode, resolveToken: jest.fn<AuthPort['resolveToken']>().mockResolvedValue(principal) };
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(isPublic) } as unknown as Reflector;
  return { port, interceptor: new GlobalAuthInterceptor(port, reflector) };
}

function ctx(req: Req): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const handler = { handle: jest.fn().mockReturnValue('next') } as unknown as CallHandler;
const bearer = (t: string): Req => ({ headers: { authorization: `Bearer ${t}` }, body: {}, params: {}, query: {} });
const user: AuthPrincipal = { id: 7, admin: false, kind: 'user' };
const admin: AuthPrincipal = { id: 0, admin: true, kind: 'admin-token' };

describe('GlobalAuthInterceptor', () => {
  it('lets @Public routes through without resolving', async () => {
    const { port, interceptor } = build('users', null, true);
    await expect(interceptor.intercept(ctx({}), handler)).resolves.toBe('next');
    expect(port.resolveToken).not.toHaveBeenCalled();
  });

  it('is idempotent when req.user is already set', async () => {
    const { port, interceptor } = build('users', null);
    await interceptor.intercept(ctx({ user }), handler);
    expect(port.resolveToken).not.toHaveBeenCalled();
  });

  describe('users mode', () => {
    it('throws Unauthorized without token', async () => {
      const { interceptor } = build('users', null);
      await expect(interceptor.intercept(ctx({ headers: {}, body: {} }), handler)).rejects.toThrow(
        new SecurityException('AUT', 'Unauthorized'),
      );
    });

    it('throws with a fingerprint for an unknown token', async () => {
      const { interceptor } = build('users', null);
      await expect(interceptor.intercept(ctx(bearer('abcdefghij')), handler)).rejects.toThrow(
        'Unrecognized token (len=10, ends=…efghij)',
      );
    });

    it('sets req.user and mirrors uid/user for a valid token', async () => {
      const { interceptor } = build('users', user);
      const req = bearer('tok');
      await interceptor.intercept(ctx(req), handler);
      expect(req.user).toBe(user);
      for (const k of ['body', 'params', 'query']) {
        expect(req[k].uid).toBe(7);
        expect(req[k].user).toBe(user);
      }
    });
  });

  describe('anonymous mode', () => {
    it('passes without token and without req.user', async () => {
      const { interceptor } = build('anonymous', null);
      const req: Req = { headers: {} };
      await expect(interceptor.intercept(ctx(req), handler)).resolves.toBe('next');
      expect(req.user).toBeUndefined();
    });

    it('throws for an invalid token', async () => {
      const { interceptor } = build('anonymous', null);
      await expect(interceptor.intercept(ctx(bearer('nope')), handler)).rejects.toThrow(/Unrecognized token/);
    });

    it('sets the admin-token principal for a valid token', async () => {
      const { interceptor } = build('anonymous', admin);
      const req = bearer('good');
      await interceptor.intercept(ctx(req), handler);
      expect(req.user).toEqual(admin);
      expect(req.query.uid).toBe(0);
    });
  });
});
