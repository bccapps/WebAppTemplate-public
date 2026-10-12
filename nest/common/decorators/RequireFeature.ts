/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { SetMetadata } from '@nestjs/common'

export const REQUIRE_FEATURE_KEY = 'requireFeature'

/**
 * Marks a controller or route as requiring a Feature Access Control gate
 * (see CLAUDE.md §4b). Must be combined with `@UseInterceptors(FeatureGuard)`.
 */
export const RequireFeature = (featureName: string) => SetMetadata(REQUIRE_FEATURE_KEY, featureName)
