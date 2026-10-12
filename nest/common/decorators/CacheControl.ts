/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { SetMetadata } from '@nestjs/common'

export const CACHE_CONTROL_KEY = 'cacheControl'

export interface CacheControlOptions {
  /**
   * 'public' allows shared caches (CDN edge, intermediate proxies) to store the
   * response. 'private' restricts storage to the requesting client's own cache —
   * use it whenever the payload varies by viewer (e.g. a `locked` flag resolved
   * from an optional auth token) even though the route itself is unauthenticated.
   */
  visibility: 'public' | 'private'
  /**
   * Module config key (see ModuleConfigSchema, CLAUDE.md §4) holding `max-age` in
   * seconds. Resolved at request time via `ConfigurationService` — never hardcode
   * the duration in the decorator call, so it stays admin-tunable without a deploy.
   */
  maxAgeConfigKey: string
  /** Optional module config key holding `stale-while-revalidate` in seconds. */
  staleWhileRevalidateConfigKey?: string
  /**
   * Request headers the response varies on, emitted as `Vary` (appended, never
   * overwriting a `Vary` already set by CORS & co).
   *
   * MANDATORY on any `private` route whose payload depends on the caller's
   * identity: `private` only stops *shared* caches from reusing the response,
   * it does NOT stop the browser's own cache from replaying the anonymous body
   * for a later authenticated request on the same URL. `vary: ['Authorization']`
   * is what keeps those two responses in separate cache entries.
   */
  vary?: string[]
}

/**
 * Sets a `Cache-Control` response header, applied by `CacheControlInterceptor`
 * (see PERFORMANCE_PLAN.md §2.1). Read via
 * `Reflector.getAllAndOverride(CACHE_CONTROL_KEY, [handler, class])`.
 *
 * ⚠️ Only meaningful on a route also exempted via `@NoTransportCrypt()`: an
 * encrypted response is a unique ciphertext per request (random IV), so a
 * `Cache-Control` on it caches nothing reusable for anyone but an exact
 * request replay.
 */
export const CacheControl = (options: CacheControlOptions) => SetMetadata(CACHE_CONTROL_KEY, options)
