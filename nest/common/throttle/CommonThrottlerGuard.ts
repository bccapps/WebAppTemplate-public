/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getOptionsToken, getStorageToken, ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerModuleOptions, ThrottlerOptions, ThrottlerStorage } from '@nestjs/throttler';
import { ConfigurationService } from '../services/ConfigurationService';
import { AUTH_PORT, type AuthPort } from '../auth/AuthPort';
import { extractBearerToken, resolveTokenOnce, type AuthRequest } from '../auth/authRequest';
import type { AuthPrincipal } from '../auth/AuthPrincipal';
import type { LocalTrustRequest } from '../auth/localTrust';
import { ThrottleRegistry } from './ThrottleRegistry';

/**
 * Global rate-limit guard of `common`. A pass-through unless `common_throttleEnabled` is true (read on every
 * request, so it can be switched from the admin without a restart). Throttlers: `default` plus the named ones of
 * {@link ThrottleRegistry}. Tracks the authenticated user, the client IP otherwise: the guard resolves the principal
 * itself through `AUTH_PORT` (the global auth interceptor runs after the guards, so `req.user` is not set yet), and
 * the interceptor reuses that result. Controllers opt out with `@SkipThrottle()`.
 */
@Injectable()
export class CommonThrottlerGuard extends ThrottlerGuard {
  private baseThrottlers: ThrottlerOptions[] = [];
  private syncedVersion = -1;

  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: ConfigurationService,
    private readonly registry: ThrottleRegistry,
    @Optional() @Inject(AUTH_PORT) private readonly authPort?: AuthPort,
  ) {
    super(options, storageService, reflector);
  }

  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.baseThrottlers = this.throttlers;
    this.syncedVersion = -1;
  }

  protected override async shouldSkip(_context: ExecutionContext): Promise<boolean> {
    const enabled: unknown = this.config.get('common_throttleEnabled');
    if (enabled !== true && enabled !== 'true') return true;
    if (this.syncedVersion !== this.registry.version) {
      this.throttlers = [...this.baseThrottlers, ...this.registry.list()];
      this.syncedVersion = this.registry.version;
    }
    return false;
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const principal = (req as AuthRequest).user ?? (await this.resolvePrincipal(req));
    const userId = principal?.id;
    if (userId !== undefined && userId !== null) return `user:${String(userId)}`;
    const ip = (req as { ip?: string }).ip;
    return `ip:${ip ?? 'unknown'}`;
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
