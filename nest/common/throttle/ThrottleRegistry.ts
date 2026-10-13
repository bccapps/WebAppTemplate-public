/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { ExecutionContext, Injectable } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';

/** A number, or a function read on every request (so a value stored in the configuration can change without a restart). */
export type ThrottleValue = number | ((context: ExecutionContext) => number | Promise<number>);

/** An additional, named throttler of the global limiter. */
export interface ThrottleRule {
  /** Unique name; `default` is reserved. Decorate a route with `@Throttle({ [name]: { limit, ttl } })` to override it there. */
  name: string;
  /** Requests allowed per window and per client. */
  limit: ThrottleValue;
  /** Window, in milliseconds. */
  ttlMs: ThrottleValue;
  /** The rule only applies to requests whose path starts with one of these prefixes; all routes when omitted. */
  paths?: string[];
  /** The rule is skipped when this returns true (evaluated after `paths`). */
  skipIf?: (context: ExecutionContext) => boolean;
}

type PathRequest = { path?: string; originalUrl?: string; url?: string };

function requestPath(context: ExecutionContext): string {
  const req = context.switchToHttp().getRequest<PathRequest>();
  return req?.path ?? (req?.originalUrl ?? req?.url ?? '').split('?')[0];
}

function validateValue(rule: string, field: string, value: ThrottleValue): void {
  if (typeof value === 'function') return;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Throttle rule "${rule}": ${field} must be a positive number or a function`);
}

/** Converts a rule into a `@nestjs/throttler` throttler (`paths` and `skipIf` merged into one `skipIf`). */
export function toThrottlerOptions(rule: ThrottleRule): ThrottlerOptions {
  const { paths, skipIf } = rule;
  return {
    name: rule.name,
    limit: rule.limit,
    ttl: rule.ttlMs,
    skipIf: (context) => {
      if (paths && paths.length > 0) {
        const path = requestPath(context);
        if (!paths.some((prefix) => path.startsWith(prefix))) return true;
      }
      return skipIf ? skipIf(context) : false;
    },
  };
}

/**
 * Additional named throttlers of the global limiter (`CommonThrottlerGuard`), next to `default`. An app registers its
 * rules once at startup (a module constructor, or `app.get(ThrottleRegistry)` in `main.ts` before `app.init()`).
 */
@Injectable()
export class ThrottleRegistry {
  private readonly rules = new Map<string, ThrottlerOptions>();
  private current = 0;

  /** Incremented on every registration; the guard re-reads {@link list} when it changes. */
  get version(): number {
    return this.current;
  }

  register(rule: ThrottleRule): void {
    const name = rule.name?.trim();
    if (!name) throw new Error('Throttle rule: name is required');
    if (name === 'default') throw new Error('Throttle rule: "default" is reserved for the limiter of common');
    if (this.rules.has(name)) throw new Error(`Throttle rule "${name}" is already registered`);
    validateValue(name, 'limit', rule.limit);
    validateValue(name, 'ttlMs', rule.ttlMs);
    this.rules.set(name, toThrottlerOptions({ ...rule, name }));
    this.current += 1;
  }

  registerAll(rules: readonly ThrottleRule[]): void {
    for (const rule of rules) this.register(rule);
  }

  list(): ThrottlerOptions[] {
    return [...this.rules.values()];
  }
}
