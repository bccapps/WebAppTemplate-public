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
import { ModuleConfigController } from './ModuleConfigController';

/**
 * Module config secrets (reveal) and writes: admin check THEN refusal of a static API token (even an administrator's). The anonymous-mode ADMIN_TOKEN principal and local-trust pass.
 * A new sensitive route is added to CRITICAL_ROUTES (the list is the drift guard).
 */
const CRITICAL_ROUTES: CriticalRoute[] = [
  { method: 'GET', path: '/api/v1/admin/module-configs/:moduleId/secret/:key', interceptors: [AdminOnlyInterceptor, RejectApiTokenInterceptor] },
  { method: 'PUT', path: '/api/v1/admin/module-configs/:moduleId', interceptors: [AdminOnlyInterceptor, RejectApiTokenInterceptor] },
];

/** Write routes deliberately left without a principal guard, with the reason (anything else must be in CRITICAL_ROUTES). */
const OPEN_ROUTES: OpenRoute[] = [];

describe('ModuleConfigController principal guards', () => {
  it('keeps every critical route behind the API-token refusal', () => {
    expect(findRouteMismatches(ModuleConfigController, CRITICAL_ROUTES)).toEqual([]);
  });

  it('classifies every write route as guarded or deliberately open', () => {
    expect(findUnclassifiedWriteRoutes(ModuleConfigController, CRITICAL_ROUTES, OPEN_ROUTES)).toEqual([]);
  });
});
