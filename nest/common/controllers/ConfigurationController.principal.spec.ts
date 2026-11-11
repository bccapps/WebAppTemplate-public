/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { AdminOnlyInterceptor } from '../interceptors/AdminOnlyInterceptor';
import { RejectApiTokenInterceptor } from '../interceptors/RejectApiTokenInterceptor';
import { type CriticalRoute, findRouteMismatches, findUnclassifiedWriteRoutes, type OpenRoute } from '../testing/controllerInterceptors.testkit';
import { ConfigurationController } from './ConfigurationController';

/**
 * Global configuration write: admin check THEN refusal of a static API token.
 * A new sensitive route is added to CRITICAL_ROUTES (the list is the drift guard).
 */
const CRITICAL_ROUTES: CriticalRoute[] = [
  { method: 'PUT', path: '/api/v1/configurations', interceptors: [AdminOnlyInterceptor, RejectApiTokenInterceptor] },
];

/** Write routes deliberately left without a principal guard, with the reason (anything else must be in CRITICAL_ROUTES). */
const OPEN_ROUTES: OpenRoute[] = [];

describe('ConfigurationController principal guards', () => {
  it('keeps every critical route behind the API-token refusal', () => {
    expect(findRouteMismatches(ConfigurationController, CRITICAL_ROUTES)).toEqual([]);
  });

  it('classifies every write route as guarded or deliberately open', () => {
    expect(findUnclassifiedWriteRoutes(ConfigurationController, CRITICAL_ROUTES, OPEN_ROUTES)).toEqual([]);
  });
});
