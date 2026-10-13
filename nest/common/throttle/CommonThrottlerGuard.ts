/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getOptionsToken, getStorageToken, ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { ConfigurationService } from '../services/ConfigurationService';
import type { AuthRequest } from '../auth/authRequest';

/**
 * Global rate-limit guard of `common`. A pass-through unless `common_throttleEnabled` is true (read on every
 * request, so it can be switched from the admin without a restart). Tracks the authenticated user when the global
 * auth interceptor already set `req.user`, the client IP otherwise. Controllers opt out with `@SkipThrottle()`.
 */
@Injectable()
export class CommonThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: ConfigurationService,
  ) {
    super(options, storageService, reflector);
  }

  protected override async shouldSkip(_context: ExecutionContext): Promise<boolean> {
    const enabled: unknown = this.config.get('common_throttleEnabled');
    return enabled !== true && enabled !== 'true';
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = (req as AuthRequest).user?.id;
    if (userId !== undefined && userId !== null) return `user:${String(userId)}`;
    const ip = (req as { ip?: string }).ip;
    return `ip:${ip ?? 'unknown'}`;
  }
}
