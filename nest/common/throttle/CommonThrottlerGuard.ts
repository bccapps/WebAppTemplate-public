/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { getOptionsToken, getStorageToken, ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerModuleOptions, ThrottlerOptions, ThrottlerStorage } from '@nestjs/throttler';
import { AUTH_PORT, type AuthPort } from '../auth/AuthPort';
import { extractBearerToken, resolveTokenOnce, type AuthRequest } from '../auth/authRequest';
import type { AuthPrincipal } from '../auth/AuthPrincipal';
import type { LocalTrustRequest } from '../auth/localTrust';
import { SERVICE_KEY_AUTH, type ServiceKeyAuthenticator, type ServiceKeyRequest } from '../auth/ServiceKeyAuth';
import { API_SCOPE_KEY, SERVICE_KEY_ROUTE_KEY } from '../decorators/ApiScope';
import { RateLimitedLog } from '../utils/rateLimitedLog';
import { ThrottleRegistry, type ThrottleTracker } from './ThrottleRegistry';

/**
 * Global rate-limit guard of `common`, always on (the `common_throttleEnabled` switch was removed on 2026-10-30; the
 * budgets stay in the configuration: `common_throttleDefaultLimit` / `…TtlMs`). Throttlers: `default` plus the named ones of
 * {@link ThrottleRegistry}. Tracks the authenticated user, the client IP otherwise: the guard resolves the principal
 * itself through `AUTH_PORT` (the global auth interceptor runs after the guards, so `req.user` is not set yet), and
 * the interceptor reuses that result. Controllers opt out with `@SkipThrottle()`; a route sets its own budget with
 * `@Throttle({ default: { limit, ttl } })`, counted apart from the other routes (the storage key includes the handler).
 * A VERIFIED service key on a route that accepts one (`@ApiScope`, `@ServiceKeyRoute`) is left to its own rate limit.
 */
@Injectable()
export class CommonThrottlerGuard extends ThrottlerGuard {
  private baseThrottlers: ThrottlerOptions[] = [];
  private syncedVersion = -1;
  /** A failing rule tracker is reported at most once a minute per rule (it may fail on every request). */
  private readonly trackerFailures = new RateLimitedLog({
    name: '[CommonThrottlerGuard] rule tracker failures',
    perWindow: 1,
    windowMs: 60_000,
    write: (line) => console.warn(line),
  });

  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly registry: ThrottleRegistry,
    @Optional() @Inject(AUTH_PORT) private readonly authPort?: AuthPort,
    @Optional() @Inject(SERVICE_KEY_AUTH) private readonly serviceKeys?: ServiceKeyAuthenticator,
  ) {
    super(options, storageService, reflector);
  }

  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.baseThrottlers = this.throttlers;
    this.syncedVersion = -1;
  }

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (this.syncedVersion !== this.registry.version) {
      this.throttlers = [...this.baseThrottlers, ...this.registry.list().map((throttler) => this.withRuleTracker(throttler))];
      this.syncedVersion = this.registry.version;
    }
    return this.governedByServiceKey(context);
  }

  /**
   * A route that accepts service keys (`@ApiScope`, `@ServiceKeyRoute` — `api-access`'s `@ApiCredit`) called with a VERIFIED key:
   * the key's own rate limit governs it (`api-access`: `rateLimitPerMin` per key), not these per-user / per-address budgets — a
   * consumer back-end serving all its users from one address would otherwise share one budget (2026-10-30). An absent, unknown,
   * revoked or expired key, or any other route (a login route, say): counted as usual. Without a provider able to verify a key
   * without counting it (`verifiedKeyId`), nothing changes.
   */
  private async governedByServiceKey(context: ExecutionContext): Promise<boolean> {
    if (!this.serviceKeys?.verifiedKeyId) return false;
    const targets = [context.getHandler(), context.getClass()];
    const keyRoute = this.reflector.getAllAndOverride<string | undefined>(API_SCOPE_KEY, targets)
      || this.reflector.getAllAndOverride<boolean | undefined>(SERVICE_KEY_ROUTE_KEY, targets);
    if (!keyRoute) return false;
    const req = context.switchToHttp().getRequest<ServiceKeyRequest>();
    return (await this.serviceKeys.verifiedKeyId(req)) !== null;
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const principal = (req as AuthRequest).user ?? (await this.resolvePrincipal(req));
    const userId = principal?.id;
    if (userId !== undefined && userId !== null) return `user:${String(userId)}`;
    const identity = await this.resolveIdentity(req);
    if (identity) return identity;
    // `req.ip` (TRUST_PROXY decides what it is), normalized by @nestjs/throttler: an IPv6 client counts per /64 (it
    // would otherwise rotate addresses inside its own prefix), an IPv4-mapped address as plain IPv4.
    const ip = await super.getTracker(req);
    return `ip:${ip || 'unknown'}`;
  }

  /** A registry rule with its own tracker counts by that key, falling back to {@link getTracker} (user, else IP). */
  private withRuleTracker(throttler: ThrottlerOptions): ThrottlerOptions {
    const tracker = this.registry.trackerOf(throttler.name ?? '');
    if (!tracker) return throttler;
    return { ...throttler, getTracker: (req, context) => this.ruleTracker(throttler.name ?? '', tracker, req, context) };
  }

  /** `key:<value>` from the rule's tracker; its fallback (empty value or a throw, never an error answer) is the default tracker. */
  private async ruleTracker(name: string, tracker: ThrottleTracker, req: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    try {
      const key = await tracker(req as unknown as Request, context);
      if (typeof key === 'string' && key.length > 0) return `key:${key}`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.trackerFailures.log(name, `[CommonThrottlerGuard] tracker of throttle rule "${name}" failed (${reason}): counting by user/IP`);
    }
    return this.getTracker(req);
  }

  /**
   * The identity a module vouches for (`ThrottleRegistry.registerIdentity`): `user:<id>` as given, any other key under `id:` (never
   * mistaken for an address or a rule key); null — so the address — when none answers or one throws (logged at most once a minute).
   */
  private async resolveIdentity(req: Record<string, unknown>): Promise<string | null> {
    for (const resolver of this.registry.identities()) {
      try {
        const key = await resolver(req as unknown as Request);
        if (typeof key === 'string' && key.length > 0) return /^user:[^:]+$/.test(key) ? key : `id:${key}`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.trackerFailures.log('identity', `[CommonThrottlerGuard] a throttle identity resolver failed (${reason}): counting by address`);
      }
    }
    return null;
  }

  /** The principal of the request without touching it; `null` (so: the IP) for a missing or rejected credential. */
  private async resolvePrincipal(req: Record<string, unknown>): Promise<AuthPrincipal | null> {
    const port = this.authPort;
    if (!port) return null;
    const token = extractBearerToken(req as AuthRequest);
    if (token) return (await resolveTokenOnce(port, req, token)).principal;
    if (port.mode !== 'anonymous') return null;
    return port.resolveRequest?.(req as unknown as LocalTrustRequest) ?? null;
  }
}
