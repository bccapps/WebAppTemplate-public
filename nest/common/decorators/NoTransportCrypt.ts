/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { SetMetadata } from '@nestjs/common'

export const NO_TRANSPORT_CRYPT_KEY = 'noTransportCrypt'

/**
 * Exempts a controller or route handler from `TransportCryptInterceptor`
 * (see PERFORMANCE_PLAN.md §2.0 — "décision C", acted 2026-09-07). Read via
 * `Reflector.getAllAndOverride(NO_TRANSPORT_CRYPT_KEY, [handler, class])`
 * inside the interceptor — closest decorator wins, exactly like
 * `@RequireFeature`. A route/controller without this decorator keeps being
 * encrypted (the default, unchanged).
 *
 * ⚠️ RESTRICTED USE — apply ONLY to infrastructure routes that carry zero
 * proprietary/business data (public config flags, UI copy, catalogue
 * *metadata*). Every value-bearing route (indicator/series values, workshop
 * layers, any project data route) MUST stay encrypted: that opacity is an
 * assumed anti-scraping defense, not an oversight — see PERFORMANCE_PLAN.md §2.
 * As of §2.0 the exhaustive, closed list is:
 *   - GET /api/v1/configurations        (ConfigurationController)
 *   - GET /api/v1/locales[/:category]   (LocaleController)
 *   - GET /api/v1/indicators/available  (IndicatorController — metadata only)
 * Do not add a fourth call site without first updating that section of the plan.
 */
export const NoTransportCrypt = () => SetMetadata(NO_TRANSPORT_CRYPT_KEY, true)
