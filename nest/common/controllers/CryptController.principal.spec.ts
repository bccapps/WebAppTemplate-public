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
import { CryptController } from './CryptController';

/**
 * Admin decrypt of a stored column: admin check THEN refusal of a static API token.
 * A new sensitive route is added to CRITICAL_ROUTES (the list is the drift guard).
 */
const CRITICAL_ROUTES: CriticalRoute[] = [
  { method: 'POST', path: '/api/v1/crypt/admin/decrypt', interceptors: [AdminOnlyInterceptor, RejectApiTokenInterceptor] },
];

/** Write routes deliberately left without a principal guard, with the reason (anything else must be in CRITICAL_ROUTES). */
const OPEN_ROUTES: OpenRoute[] = [
  { method: 'POST', path: '/api/v1/crypt/session', reason: '@Public, throttled key-exchange handshake of the transport encryption: no principal exists yet' },
];

describe('CryptController principal guards', () => {
  it('keeps every critical route behind the API-token refusal', () => {
    expect(findRouteMismatches(CryptController, CRITICAL_ROUTES)).toEqual([]);
  });

  it('classifies every write route as guarded or deliberately open', () => {
    expect(findUnclassifiedWriteRoutes(CryptController, CRITICAL_ROUTES, OPEN_ROUTES)).toEqual([]);
  });
});
