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
import type { Request } from 'express';

/** A number, or a function read on every request (so a value stored in the configuration can change without a restart). */
export type ThrottleValue = number | ((context: ExecutionContext) => number | Promise<number>);

/**
 * What one rule counts by, instead of the authenticated user / client IP of the guard (e.g. an API key id, a runner id).
 * Called before the auth interceptor (`req.user` is not set yet). A non-empty string ⇒ that key (namespaced `key:<value>`);
 * `undefined`, `null`, `''` or a throw ⇒ the guard's default tracker (user, else IP), never an error.
 */
export type ThrottleTracker = (req: Request, context: ExecutionContext) => string | null | undefined | Promise<string | null | undefined>;

/**
 * Who a request WITHOUT a signed-in user is, for every budget that would otherwise count it by address: see
 * {@link ThrottleRegistry.registerIdentity}. The key to count under, or nothing (the address then).
 */
export type ThrottleIdentity = (req: Request) => string | null | undefined | Promise<string | null | undefined>;

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
  /**
   * Optional key this rule counts by (see {@link ThrottleTracker}); other rules and `default` keep the user / IP. Return a
   * key only for a credential you trust (verified or cached): an unverified header lets a client pick a fresh bucket.
   */
  tracker?: ThrottleTracker;
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
  private readonly trackers = new Map<string, ThrottleTracker>();
  private readonly identityResolvers: ThrottleIdentity[] = [];
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
    if (rule.tracker !== undefined && typeof rule.tracker !== 'function') throw new Error(`Throttle rule "${name}": tracker must be a function`);
    this.rules.set(name, toThrottlerOptions({ ...rule, name }));
    if (rule.tracker) this.trackers.set(name, rule.tracker);
    this.current += 1;
  }

  registerAll(rules: readonly ThrottleRule[]): void {
    for (const rule of rules) this.register(rule);
  }

  list(): ThrottlerOptions[] {
    return [...this.rules.values()];
  }

  /**
   * Counts the requests presenting a credential the registering module VERIFIED — not a signed-in user: an API key, a runner —
   * by that credential instead of their address (all the agents of one machine share an address), for `default` and every rule
   * without its own tracker. Return `user:<id>` for a credential acting for a user (that user's own budgets: creating more
   * credentials never adds budget), else a key of your own (counted under `id:<key>`); nothing, or a throw, keeps the address.
   * Asked in registration order, the first answer wins, on every request without a user: memoise the verification on the
   * request. Never a key read from an unverified header (a client would pick a fresh bucket per request).
   */
  registerIdentity(resolver: ThrottleIdentity): void {
    if (typeof resolver !== 'function') throw new Error('Throttle identity: a function is required');
    this.identityResolvers.push(resolver);
  }

  /** The resolvers of {@link registerIdentity}, in registration order. */
  identities(): readonly ThrottleIdentity[] {
    return this.identityResolvers;
  }

  /** The tracker of the rule `name`, if it declared one (the guard wraps it with its fallback). */
  trackerOf(name: string): ThrottleTracker | undefined {
    return this.trackers.get(name);
  }
}
