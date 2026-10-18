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
import { resolveTokenOnce } from './authRequest';
import { GlobalAuthInterceptor } from './GlobalAuthInterceptor';
import { API_SCOPE_KEY } from '../decorators/ApiScope';
import type { ServiceKeyAuthenticator, ServicePrincipal } from './ServiceKeyAuth';

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

    it('applies the principal granted by resolveRequest (local trust)', async () => {
      const { port, interceptor } = build('anonymous', null);
      const local: AuthPrincipal = { id: 0, admin: true, kind: 'local-trust' };
      port.resolveRequest = jest.fn<NonNullable<AuthPort['resolveRequest']>>().mockReturnValue(local);
      const req: Req = { headers: {}, query: {} };
      await interceptor.intercept(ctx(req), handler);
      expect(req.user).toEqual(local);
    });

    it('does not consult resolveRequest in users mode', async () => {
      const { port, interceptor } = build('users', null);
      port.resolveRequest = jest.fn<NonNullable<AuthPort['resolveRequest']>>();
      await expect(interceptor.intercept(ctx({ headers: {}, body: {} }), handler)).rejects.toThrow('Unauthorized');
      expect(port.resolveRequest).not.toHaveBeenCalled();
    });

    it('sets the admin-token principal for a valid token', async () => {
      const { interceptor } = build('anonymous', admin);
      const req = bearer('good');
      await interceptor.intercept(ctx(req), handler);
      expect(req.user).toEqual(admin);
      expect(req.query.uid).toBe(0);
    });
  });

  describe('shared resolution with the rate-limit guard', () => {
    it('does not resolve a token a second time when the guard already did', async () => {
      const { port, interceptor } = build('users', user);
      const req = bearer('tok');
      await resolveTokenOnce(port, req, 'tok');
      await interceptor.intercept(ctx(req), handler);
      expect(port.resolveToken).toHaveBeenCalledTimes(1);
      expect(req.user).toBe(user);
    });

    it('rethrows the error the port raised, also when the guard resolved first', async () => {
      const { port, interceptor } = build('users', null);
      const failure = new SecurityException('AUT', 'Invalid or expired token');
      (port.resolveToken as jest.Mock).mockRejectedValue(failure as never);
      const req = bearer('tok');
      await resolveTokenOnce(port, req, 'tok');
      await expect(interceptor.intercept(ctx(req), handler)).rejects.toBe(failure);
      expect(port.resolveToken).toHaveBeenCalledTimes(1);
    });
  });

  describe('service keys on @ApiScope routes', () => {
    const service: ServicePrincipal = { kind: 'service', scope: 'tradingplatform:read', tenantId: 3, keyId: 9 };

    function buildScoped(scope: string | undefined, outcome: ServicePrincipal | null | Error, withProvider = true) {
      const port: AuthPort = { mode: 'users', resolveToken: jest.fn<AuthPort['resolveToken']>().mockResolvedValue(user) };
      const reflector = { getAllAndOverride: jest.fn((key: string) => (key === API_SCOPE_KEY ? scope : false)) } as unknown as Reflector;
      const authenticate = jest.fn<ServiceKeyAuthenticator['authenticate']>();
      if (outcome instanceof Error) authenticate.mockRejectedValue(outcome);
      else authenticate.mockResolvedValue(outcome);
      const keys: ServiceKeyAuthenticator = { authenticate };
      return { port, authenticate, interceptor: new GlobalAuthInterceptor(port, reflector, withProvider ? keys : undefined) };
    }
    const keyed = (): Req => ({ headers: { 'x-api-key': 'ctd_key' }, body: { user: { id: 1 } }, params: {}, query: {} });

    it('admits a key with the route scope: service principal, no user, client identity scrubbed', async () => {
      const { port, authenticate, interceptor } = buildScoped('tradingplatform:read', service);
      const req = keyed();
      await expect(interceptor.intercept(ctx(req), handler)).resolves.toBe('next');
      expect(authenticate).toHaveBeenCalledWith(req, 'tradingplatform:read');
      expect(req.servicePrincipal).toBe(service);
      expect(req.user).toBeUndefined();
      expect(req.body.user).toBeUndefined();
      expect(port.resolveToken).not.toHaveBeenCalled();
    });

    it('propagates a refusal of the provider (bad key, missing scope)', async () => {
      const refusal = new SecurityException('API_KEY', 'Invalid API key');
      const { interceptor } = buildScoped('tradingplatform:read', refusal);
      await expect(interceptor.intercept(ctx(keyed()), handler)).rejects.toBe(refusal);
    });

    it('falls back to the user token when the request carries no key', async () => {
      const { port, interceptor } = buildScoped('tradingplatform:read', null);
      const req = bearer('tok');
      await interceptor.intercept(ctx(req), handler);
      expect(port.resolveToken).toHaveBeenCalledWith('tok');
      expect(req.user).toBe(user);
      expect(req.servicePrincipal).toBeUndefined();
    });

    it('never consults the provider on a route without @ApiScope', async () => {
      const { authenticate, interceptor } = buildScoped(undefined, service);
      await expect(interceptor.intercept(ctx(keyed()), handler)).rejects.toThrow(new SecurityException('AUT', 'Unauthorized'));
      expect(authenticate).not.toHaveBeenCalled();
    });

    it('keeps the user-only behaviour when no provider is linked', async () => {
      const { interceptor } = buildScoped('tradingplatform:read', service, false);
      await expect(interceptor.intercept(ctx(keyed()), handler)).rejects.toThrow(new SecurityException('AUT', 'Unauthorized'));
    });
  });
});
