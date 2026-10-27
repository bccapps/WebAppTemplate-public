/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Extension points that let a module use capabilities of an OPTIONAL module without
 * importing it: `user` uses `infra` / `commerce`, public modules (`issue-report`)
 * use `user`.
 *
 * The consumer depends on these tokens/interfaces only (they live in `common`, which is
 * always present). The optional module provides the implementation under the token
 * (`{ provide: TOKEN, useExisting: RealService }`) and exports it from a global
 * scope; the consumer injects it with `@Optional() @Inject(TOKEN)` and degrades
 * gracefully when absent. This keeps the consumer compilable and bootable when the
 * provider's folder is not part of the project.
 */

/** Minimal key/value cache. Provided by `infra` (`CacheService`, Redis, noop without REDIS_URL). */
export const KEY_VALUE_CACHE = 'KEY_VALUE_CACHE';
export interface KeyValueCache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSec?: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Business-level user gauges sink. Provided by `infra` (`PrometheusService`) when Prometheus is enabled. */
export const USER_METRICS_SINK = 'USER_METRICS_SINK';
export interface UserMetricsSink {
  updateUserCounts(totalUsers: number, activeUsers24h: number): void;
}

/**
 * Tells `user` whether a tier is sold. Provided by `commerce` (`ProductService`).
 * Absent => every tier is considered free (nothing is sold).
 */
export const TIER_PRICING_PROVIDER = 'TIER_PRICING_PROVIDER';
export interface TierPricingProvider {
  /** True when an active + recurring commerce Product grants this tier. */
  hasActiveRecurringProduct(tierId: number): Promise<boolean>;
}

/**
 * Health contributors aggregated by `GET /api/v1/health` (`common`). A module that knows how to probe something
 * (database, cache, an upstream API) provides one contributor, or an array of them, under this token
 * (`{ provide: HEALTH_CONTRIBUTORS, useExisting: MyContributor }`) and exports it from a global scope.
 * Absent => the endpoint only reports process liveness. Only one provider per project: a module that needs
 * several contributors provides an array.
 */
export const HEALTH_CONTRIBUTORS = 'HEALTH_CONTRIBUTORS';
export type HealthState = 'ok' | 'degraded' | 'down';
export interface HealthContribution {
  /** `down` makes the endpoint answer 503; `degraded` stays 200. */
  status: HealthState;
  [detail: string]: unknown;
}
export interface HealthContributor {
  /** Key under which the contribution appears in the `checks` object of the response. */
  readonly key: string;
  check(): Promise<HealthContribution> | HealthContribution;
}

/**
 * How to reach a user of the app: provided by `user` (`UserContactService`, global scope). Lets a public module
 * mail a user (e.g. `issue-report`: closure notice of a report) without importing the private `user` module and
 * without keeping its own copy of the address. Absent => no e-mail; the consumer says so once in the log.
 */
export const USER_CONTACT = 'USER_CONTACT';
export interface UserContactProvider {
  /** Address of an active account, `null` when there is none (unknown, deactivated or deleted account, empty address). */
  emailOf(userId: string | number): Promise<string | null>;
  /** Preferred language of the account (`fr`, `en`…), `null` when unknown. */
  localeOf?(userId: string | number): Promise<string | null>;
}
