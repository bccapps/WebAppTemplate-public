/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Throttle } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { CommonThrottlerGuard } from './CommonThrottlerGuard';
import { FailOpenThrottlerStorage } from './FailOpenThrottlerStorage';
import { buildThrottlerOptions, throttleProviders } from './throttleProviders';
import { Test } from '@nestjs/testing';
import { ConfigurationService } from '../services/ConfigurationService';
import { RedisService } from '../services/RedisService';
import { resolveTokenOnce } from '../auth/authRequest';
import type { AuthPort } from '../auth/AuthPort';
import type { AuthPrincipal } from '../auth/AuthPrincipal';
import { ThrottleRegistry } from './ThrottleRegistry';
import { DonationController, DONATION_CHECKOUT_THROTTLE } from '../controllers/DonationController';
import { CookieConsentController } from '../controllers/CookieConsentController';
import { CryptController, CRYPT_SESSION_THROTTLE } from '../controllers/CryptController';
import { EventStreamController } from '../event-stream/EventStreamController';

const fakeRedis = (eval_: (...a: unknown[]) => Promise<unknown>) =>
  ({ getClient: () => ({ eval: eval_ }) }) as unknown as ConstructorParameters<typeof FailOpenThrottlerStorage>[0];

describe('FailOpenThrottlerStorage', () => {
  it('counts in memory without Redis and blocks above the limit', async () => {
    const storage = new FailOpenThrottlerStorage({ getClient: () => null });
    const first = await storage.increment('k', 1000, 2, 5000, 'default');
    await storage.increment('k', 1000, 2, 5000, 'default');
    const third = await storage.increment('k', 1000, 2, 5000, 'default');
    expect(first).toMatchObject({ totalHits: 1, isBlocked: false, timeToBlockExpire: 0 });
    expect(third).toMatchObject({ totalHits: 3, isBlocked: true, timeToBlockExpire: 5000 });
  });

  it('uses Redis when available', async () => {
    const evalFn = jest.fn(async () => [4, 800]);
    const storage = new FailOpenThrottlerStorage(fakeRedis(evalFn));
    const res = await storage.increment('k', 1000, 3, 0, 'default');
    expect(evalFn).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ totalHits: 4, timeToExpire: 800, isBlocked: true });
  });

  it('fails open to memory when a Redis command throws', async () => {
    const storage = new FailOpenThrottlerStorage(fakeRedis(async () => { throw new Error('down'); }));
    const res = await storage.increment('k', 1000, 3, 0, 'default');
    expect(res).toMatchObject({ totalHits: 1, isBlocked: false });
  });
});

describe('buildThrottlerOptions', () => {
  it('reads limit and window from the configuration at call time, with defaults', async () => {
    const values: Record<string, unknown> = {};
    const options = buildThrottlerOptions({ get: (k: string) => values[k] }, new FailOpenThrottlerStorage({ getClient: () => null }));
    const throttler = (options as { throttlers: { limit: () => number; ttl: () => number }[] }).throttlers[0];
    expect(throttler.limit()).toBe(300);
    expect(throttler.ttl()).toBe(60000);
    values['common_throttleDefaultLimit'] = '5';
    values['common_throttleDefaultTtlMs'] = 2000;
    expect(throttler.limit()).toBe(5);
    expect(throttler.ttl()).toBe(2000);
  });
});

type Req = Record<string, unknown>;

describe('CommonThrottlerGuard', () => {
  const build = (config: Record<string, unknown>, authPort?: AuthPort, registry = new ThrottleRegistry()) => {
    const storage = new FailOpenThrottlerStorage({ getClient: () => null });
    const options = buildThrottlerOptions({ get: (k: string) => config[k] }, storage);
    const guard = new CommonThrottlerGuard(
      options,
      storage as unknown as ThrottlerStorage,
      new Reflector(),
      registry,
      authPort,
    );
    return guard;
  };
  const request = (req: Req): { ctx: ExecutionContext; res: { header: jest.Mock } } => {
    const res = { header: jest.fn(), setHeader: jest.fn() };
    class Ctl {
      handler(): void {}
    }
    const ctx = {
      getClass: () => Ctl,
      getHandler: () => Ctl.prototype.handler,
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    return { ctx, res };
  };
  const ctx = (user?: { id: string }): ExecutionContext => request({ ip: '1.2.3.4', headers: {}, user }).ctx;

  it('rejects above the limit (always on: no switch since 2026-10-30)', async () => {
    const guard = build({ common_throttleDefaultLimit: 2 });
    await guard.onModuleInit();
    expect(await guard.canActivate(ctx())).toBe(true);
    expect(await guard.canActivate(ctx())).toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow();
  });

  it('tracks users apart from each other', async () => {
    const guard = build({ common_throttleDefaultLimit: 1 });
    await guard.onModuleInit();
    expect(await guard.canActivate(ctx({ id: 'u1' }))).toBe(true);
    expect(await guard.canActivate(ctx({ id: 'u2' }))).toBe(true);
    await expect(guard.canActivate(ctx({ id: 'u1' }))).rejects.toThrow();
  });

  describe('tracker resolved through AUTH_PORT (req.user is not set yet when the guard runs)', () => {
    const user: AuthPrincipal = { id: 7, admin: false, kind: 'user' };
    const port = (principal: AuthPrincipal | null, mode: AuthPort['mode'] = 'users'): AuthPort => ({
      mode,
      resolveToken: jest.fn<AuthPort['resolveToken']>(async (token) => {
        if (token === 'boom') throw new Error('Invalid or expired token');
        return token === 'good' ? principal : null;
      }),
    });
    const tracker = (guard: CommonThrottlerGuard, req: Req): Promise<string> =>
      (guard as unknown as { getTracker(r: Req): Promise<string> }).getTracker(req);
    const bearer = (token: string): Req => ({ ip: '9.9.9.9', headers: { authorization: `Bearer ${token}` } });

    it('keys an authenticated request by user, without setting req.user', async () => {
      const guard = build({}, port(user));
      const req = bearer('good');
      expect(await tracker(guard, req)).toBe('user:7');
      expect(req.user).toBeUndefined();
    });

    it('keys an anonymous request, an unknown token and a rejected token by IP', async () => {
      const guard = build({}, port(user));
      expect(await tracker(guard, { ip: '9.9.9.9', headers: {} })).toBe('ip:9.9.9.9');
      expect(await tracker(guard, bearer('nope'))).toBe('ip:9.9.9.9');
      expect(await tracker(guard, bearer('boom'))).toBe('ip:9.9.9.9');
    });

    it('prefers an already set req.user and falls back to the IP without an AUTH_PORT', async () => {
      const guard = build({});
      expect(await tracker(guard, { ip: '1.1.1.1', headers: {}, user })).toBe('user:7');
      expect(await tracker(guard, bearer('good'))).toBe('ip:9.9.9.9');
    });

    it('uses the local-trust principal of an anonymous-mode port', async () => {
      const local: AuthPrincipal = { id: 0, admin: true, kind: 'local-trust' };
      const anonymous: AuthPort = { ...port(null, 'anonymous'), resolveRequest: () => local };
      expect(await tracker(build({}, anonymous), { ip: '1.1.1.1', headers: {} })).toBe('user:0');
      const usersMode: AuthPort = { ...port(null, 'users'), resolveRequest: () => local };
      expect(await tracker(build({}, usersMode), { ip: '1.1.1.1', headers: {} })).toBe('ip:1.1.1.1');
    });

    it('resolves the token once for the guard and the auth interceptor', async () => {
      const authPort = port(user);
      const guard = build({}, authPort);
      const req = bearer('good');
      await tracker(guard, req);
      expect((await resolveTokenOnce(authPort, req, 'good')).principal).toBe(user);
      expect(authPort.resolveToken).toHaveBeenCalledTimes(1);
    });

    it('limits a user across IPs and keeps another user apart', async () => {
      const authPort: AuthPort = {
        mode: 'users',
        resolveToken: async (token) => ({ id: Number(token), admin: false, kind: 'user' }),
      };
      const guard = build({ common_throttleDefaultLimit: 1 }, authPort);
      await guard.onModuleInit();
      const as = (token: string, ip: string): ExecutionContext => request({ ip, headers: { authorization: `Bearer ${token}` } }).ctx;
      expect(await guard.canActivate(as('1', '10.0.0.1'))).toBe(true);
      expect(await guard.canActivate(as('2', '10.0.0.1'))).toBe(true);
      await expect(guard.canActivate(as('1', '10.0.0.2'))).rejects.toThrow();
    });
  });

  describe('route budgets of the anonymous routes of common (real controllers, keyed by IP)', () => {
    type Handler = (...args: never[]) => unknown;
    const on = (cls: abstract new (...args: never[]) => unknown, handler: Handler, ip: string): ExecutionContext => {
      const req = { ip, headers: {} };
      return {
        getClass: () => cls,
        getHandler: () => handler,
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: jest.fn() }) }),
      } as unknown as ExecutionContext;
    };
    const enabled = () => build({ common_throttleDefaultLimit: 1000 });

    it('applies @Throttle of the Stripe checkout per IP, apart from the other routes', async () => {
      const guard = enabled();
      await guard.onModuleInit();
      const checkout = DonationController.prototype.createStripeCheckoutSession as Handler;
      for (let i = 0; i < DONATION_CHECKOUT_THROTTLE.limit; i += 1) {
        expect(await guard.canActivate(on(DonationController, checkout, '198.51.100.1'))).toBe(true);
      }
      await expect(guard.canActivate(on(DonationController, checkout, '198.51.100.1'))).rejects.toThrow();
      expect(await guard.canActivate(on(DonationController, checkout, '198.51.100.2'))).toBe(true);
      const config = DonationController.prototype.getConfig as Handler;
      expect(await guard.canActivate(on(DonationController, config, '198.51.100.1'))).toBe(true);
    });

    it('applies the crypt session and cookie-consent budgets', async () => {
      const guard = enabled();
      await guard.onModuleInit();
      const session = CryptController.prototype.createSession as Handler;
      for (let i = 0; i < CRYPT_SESSION_THROTTLE.limit; i += 1) await guard.canActivate(on(CryptController, session, '203.0.113.9'));
      await expect(guard.canActivate(on(CryptController, session, '203.0.113.9'))).rejects.toThrow();
      const consent = CookieConsentController.prototype.log as Handler;
      for (let i = 0; i < 10; i += 1) await guard.canActivate(on(CookieConsentController, consent, '203.0.113.9'));
      await expect(guard.canActivate(on(CookieConsentController, consent, '203.0.113.9'))).rejects.toThrow();
    });

    it('lets a @SkipThrottle() controller through whatever the limit', async () => {
      const guard = build({ common_throttleDefaultLimit: 1 });
      await guard.onModuleInit();
      const stream = EventStreamController.prototype.stream as Handler;
      for (let i = 0; i < 5; i += 1) expect(await guard.canActivate(on(EventStreamController, stream, '203.0.113.9'))).toBe(true);
    });

    it('counts an IPv6 client per /64 (no escape by rotating addresses) and an IPv4-mapped one as IPv4', async () => {
      const guard = build({});
      const tracker = (ip: string) => (guard as unknown as { getTracker(r: Req): Promise<string> }).getTracker({ ip, headers: {} });
      expect(await tracker('2001:db8:1:2::a')).toBe(await tracker('2001:db8:1:2:ffff::b'));
      expect(await tracker('2001:db8:1:2::a')).not.toBe(await tracker('2001:db8:1:3::a'));
      expect(await tracker('::ffff:198.51.100.7')).toBe('ip:198.51.100.7');
      expect(await tracker('198.51.100.7')).toBe('ip:198.51.100.7');
    });
  });

  describe('named throttlers', () => {
    const build2 = (registry: ThrottleRegistry) =>
      build({ common_throttleDefaultLimit: 1000 }, undefined, registry);
    const at = (path: string, ip = '1.2.3.4'): { ctx: ExecutionContext; res: { header: jest.Mock } } =>
      request({ ip, path, headers: {} });

    it('applies a rule registered after startup, only under its paths', async () => {
      const registry = new ThrottleRegistry();
      const guard = build2(registry);
      await guard.onModuleInit();
      expect(await guard.canActivate(at('/api/series/1').ctx)).toBe(true);
      registry.register({ name: 'series', limit: 1, ttlMs: 60_000, paths: ['/api/series'] });
      expect(await guard.canActivate(at('/api/series/1').ctx)).toBe(true);
      await expect(guard.canActivate(at('/api/series/2').ctx)).rejects.toThrow();
      for (let i = 0; i < 3; i += 1) expect(await guard.canActivate(at('/api/other').ctx)).toBe(true);
    });

    it('honours a skipIf predicate and a limit resolved on every request', async () => {
      const registry = new ThrottleRegistry();
      let limit = 1;
      registry.register({ name: 'strict', limit: () => limit, ttlMs: 60_000, skipIf: (c) => c.switchToHttp().getRequest().path === '/free' });
      const guard = build2(registry);
      await guard.onModuleInit();
      for (let i = 0; i < 3; i += 1) expect(await guard.canActivate(at('/free').ctx)).toBe(true);
      expect(await guard.canActivate(at('/x').ctx)).toBe(true);
      await expect(guard.canActivate(at('/x').ctx)).rejects.toThrow();
      limit = 5;
      expect(await guard.canActivate(at('/x').ctx)).toBe(true);
    });

    it('reports the named throttler in its own headers', async () => {
      const registry = new ThrottleRegistry();
      registry.register({ name: 'series', limit: 5, ttlMs: 60_000 });
      const guard = build2(registry);
      await guard.onModuleInit();
      const { ctx: c, res } = at('/a');
      await guard.canActivate(c);
      expect(res.header).toHaveBeenCalledWith('X-RateLimit-Limit-series', 5);
    });

    it('lets a route override a named throttler with @Throttle({ name })', async () => {
      const registry = new ThrottleRegistry();
      registry.register({ name: 'series', limit: 100, ttlMs: 60_000 });
      const guard = build2(registry);
      await guard.onModuleInit();
      class Ctl {
        @Throttle({ series: { limit: 1, ttl: 60_000 } })
        handler(): void {}
      }
      const req = { ip: '1.2.3.4', path: '/a', headers: {} };
      const c = {
        getClass: () => Ctl,
        getHandler: () => Ctl.prototype.handler,
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: jest.fn() }) }),
      } as unknown as ExecutionContext;
      expect(await guard.canActivate(c)).toBe(true);
      await expect(guard.canActivate(c)).rejects.toThrow();
    });
  });

  describe('named throttlers with their own tracker (ThrottleRule.tracker)', () => {
    const enabledGuard = (registry: ThrottleRegistry) => build({ common_throttleDefaultLimit: 1000 }, undefined, registry);
    const call = (ip: string, headers: Record<string, string> = {}): ExecutionContext => request({ ip, path: '/api/v1/mcp', headers }).ctx;
    const byKeyHeader = (req: { headers: Record<string, unknown> }) => req.headers['x-key'] as string | undefined;

    it('counts per returned key, across IPs, and keeps keys apart', async () => {
      const registry = new ThrottleRegistry();
      registry.register({ name: 'mcp', limit: 1, ttlMs: 60_000, tracker: byKeyHeader });
      const guard = enabledGuard(registry);
      await guard.onModuleInit();
      expect(await guard.canActivate(call('10.0.0.1', { 'x-key': 'k1' }))).toBe(true);
      await expect(guard.canActivate(call('10.0.0.2', { 'x-key': 'k1' }))).rejects.toThrow();
      expect(await guard.canActivate(call('10.0.0.1', { 'x-key': 'k2' }))).toBe(true);
    });

    it('accepts an async tracker and namespaces its key apart from the user/IP keys', async () => {
      const registry = new ThrottleRegistry();
      registry.register({ name: 'runner', limit: 5, ttlMs: 60_000, tracker: async () => 'ip:10.0.0.9' });
      const guard = enabledGuard(registry);
      await guard.onModuleInit();
      expect(await guard.canActivate(call('10.0.0.9'))).toBe(true);
      const runner = (guard as unknown as { throttlers: { name?: string; getTracker?: (r: Req, c: ExecutionContext) => Promise<string> }[] }).throttlers.find(
        (t) => t.name === 'runner',
      );
      expect(await runner?.getTracker?.({ ip: '10.0.0.9', headers: {} }, call('10.0.0.9'))).toBe('key:ip:10.0.0.9');
    });

    it('falls back to the user/IP tracker on an empty key and on a throw, without failing the request', async () => {
      const registry = new ThrottleRegistry();
      registry.register({ name: 'empty', limit: 1, ttlMs: 60_000, tracker: () => undefined });
      registry.register({ name: 'broken', limit: 1, ttlMs: 60_000, tracker: () => { throw new Error('db down'); } });
      const guard = enabledGuard(registry);
      await guard.onModuleInit();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(await guard.canActivate(call('10.0.0.1'))).toBe(true);
        expect(await guard.canActivate(call('10.0.0.2'))).toBe(true);
        await expect(guard.canActivate(call('10.0.0.1'))).rejects.toThrow(/Too Many Requests/);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('tracker of throttle rule "broken" failed (db down)');
      } finally {
        warn.mockRestore();
        (guard as unknown as { trackerFailures: { flush(): void } }).trackerFailures.flush();
      }
    });

    it('leaves the default throttler and the rules without a tracker on user/IP', async () => {
      const registry = new ThrottleRegistry();
      registry.register({ name: 'plain', limit: 1, ttlMs: 60_000 });
      registry.register({ name: 'keyed', limit: 100, ttlMs: 60_000, tracker: byKeyHeader });
      const guard = build({ common_throttleDefaultLimit: 2 }, undefined, registry);
      await guard.onModuleInit();
      expect(registry.trackerOf('plain')).toBeUndefined();
      expect(await guard.canActivate(call('10.0.0.1', { 'x-key': 'a' }))).toBe(true);
      // `plain` (limit 1, per IP) refuses the same IP whatever the key.
      await expect(guard.canActivate(call('10.0.0.1', { 'x-key': 'b' }))).rejects.toThrow();
      expect(await guard.canActivate(call('10.0.0.3', { 'x-key': 'a' }))).toBe(true);
    });

    it('refuses a tracker that is not a function', () => {
      expect(() => new ThrottleRegistry().register({ name: 'x', limit: 1, ttlMs: 1, tracker: 'nope' as never })).toThrow(/tracker must be a function/);
    });
  });
});

describe('ThrottleRegistry', () => {
  it('rejects reserved, blank and duplicate names and non-positive numbers', () => {
    const registry = new ThrottleRegistry();
    expect(() => registry.register({ name: 'default', limit: 1, ttlMs: 1 })).toThrow(/reserved/);
    expect(() => registry.register({ name: ' ', limit: 1, ttlMs: 1 })).toThrow(/name is required/);
    expect(() => registry.register({ name: 'a', limit: 0, ttlMs: 1 })).toThrow(/limit/);
    expect(() => registry.register({ name: 'a', limit: 1, ttlMs: Number.NaN })).toThrow(/ttlMs/);
    registry.register({ name: 'a', limit: 1, ttlMs: 1 });
    expect(() => registry.register({ name: 'a', limit: 1, ttlMs: 1 })).toThrow(/already registered/);
  });

  it('lists the registered rules and bumps its version', () => {
    const registry = new ThrottleRegistry();
    registry.registerAll([{ name: 'a', limit: 1, ttlMs: 1 }, { name: 'b', limit: 2, ttlMs: 2 }]);
    expect(registry.list().map((r) => r.name)).toEqual(['a', 'b']);
    expect(registry.version).toBe(2);
  });
});

describe('Nest wiring (throttleProviders + guard, as in CommonModule)', () => {
  it('resolves the guard through the dependency injector', async () => {
    const config = { get: (k: string): unknown => (k === 'common_throttleDefaultLimit' ? 1 : undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ...throttleProviders,
        CommonThrottlerGuard,
        ThrottleRegistry,
        { provide: ConfigurationService, useValue: config },
        { provide: RedisService, useValue: { getClient: () => null } },
      ],
    }).compile();
    await moduleRef.init();
    const guard = moduleRef.get(CommonThrottlerGuard);
    expect(guard).toBeInstanceOf(CommonThrottlerGuard);
  });
});
