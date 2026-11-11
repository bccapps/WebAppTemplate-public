/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { AdminOnlyInterceptor } from '../../common/interceptors/AdminOnlyInterceptor';
import { RejectApiTokenInterceptor } from '../../common/interceptors/RejectApiTokenInterceptor';
import { type CriticalRoute, findRouteMismatches, findUnclassifiedWriteRoutes, type OpenRoute } from '../../common/testing/controllerInterceptors.testkit';
import { VoiceAccessController } from './VoiceAccessController';

/**
 * Administrator voice accesses (provider keys): class-level AdminOnlyInterceptor THEN the refusal of a static API token even an administrator's.
 * A new sensitive route is added to CRITICAL_ROUTES (the list is the drift guard).
 */
const CRITICAL_ROUTES: CriticalRoute[] = [
  { method: 'POST', path: '/api/v1/voice-accesses', interceptors: [AdminOnlyInterceptor, RejectApiTokenInterceptor] },
  { method: 'PUT', path: '/api/v1/voice-accesses/:id', interceptors: [AdminOnlyInterceptor, RejectApiTokenInterceptor] },
  { method: 'DELETE', path: '/api/v1/voice-accesses/:id', interceptors: [AdminOnlyInterceptor, RejectApiTokenInterceptor] },
];

/** Write routes deliberately left without a principal guard, with the reason (anything else must be in CRITICAL_ROUTES). */
const OPEN_ROUTES: OpenRoute[] = [];

describe('VoiceAccessController principal guards', () => {
  it('keeps every critical route behind its principal guard', () => {
    expect(findRouteMismatches(VoiceAccessController, CRITICAL_ROUTES)).toEqual([]);
  });

  it('classifies every write route as guarded or deliberately open', () => {
    expect(findUnclassifiedWriteRoutes(VoiceAccessController, CRITICAL_ROUTES, OPEN_ROUTES)).toEqual([]);
  });
});
