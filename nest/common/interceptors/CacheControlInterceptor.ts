/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { CACHE_CONTROL_KEY, CacheControlOptions } from '../decorators/CacheControl';
import { ConfigurationService } from '../services/ConfigurationService';

/**
 * Applies the `Cache-Control` header declared by `@CacheControl()` on a route
 * or controller — see PERFORMANCE_PLAN.md §2.1. Registered globally
 * (`APP_INTERCEPTOR`, CommonModule) so any module can opt a route in without
 * wiring anything beyond the decorator; a route without `@CacheControl` is
 * left untouched (no header set), matching the `@RequireFeature`/`FeatureGuard`
 * pattern already used for feature gating.
 *
 * Durations are resolved from `ConfigurationService` at request time (module
 * config keys named by the decorator), never hardcoded here, so they stay
 * admin-tunable without a deploy. A missing/non-numeric config value falls
 * back to `max-age=0` (no caching) rather than a guessed duration — failing
 * safe towards "don't cache" if a config key is ever misspelled.
 */
@Injectable()
export class CacheControlInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly configurationService: ConfigurationService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const options = this.reflector.getAllAndOverride<CacheControlOptions | undefined>(CACHE_CONTROL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) {
      return next.handle();
    }

    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      tap(() => {
        if (response.writableEnded || response.headersSent) {
          return;
        }
        response.setHeader('Cache-Control', this.buildDirective(options));
        // `vary()` appends to whatever is already there (CORS sets `Vary: Origin`)
        // instead of clobbering it — see CacheControlOptions.vary for why an
        // identity-dependent payload needs this on top of `private`.
        if (options.vary?.length) {
          for (const header of options.vary) response.vary(header);
        }
      }),
    );
  }

  private buildDirective(options: CacheControlOptions): string {
    const directives = [options.visibility, `max-age=${this.resolveSeconds(options.maxAgeConfigKey)}`];
    if (options.staleWhileRevalidateConfigKey) {
      directives.push(`stale-while-revalidate=${this.resolveSeconds(options.staleWhileRevalidateConfigKey)}`);
    }
    return directives.join(', ');
  }

  private resolveSeconds(configKey: string): number {
    const raw = this.configurationService.get(configKey);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
}
