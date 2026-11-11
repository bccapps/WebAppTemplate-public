/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { RejectApiTokenInterceptor } from '../../common/interceptors/RejectApiTokenInterceptor';
import { type CriticalRoute, findRouteMismatches, findUnclassifiedWriteRoutes, type OpenRoute } from '../../common/testing/controllerInterceptors.testkit';
import { RequireVoiceOwnerInterceptor } from './RequireVoiceOwnerInterceptor';
import { UserVoiceAccessController } from './UserVoiceAccessController';

/**
 * Voice provider keys of a user (class guard RequireVoiceOwnerInterceptor): negative guard (an API token is refused) because the desktop flavour of AgentHub links voice and its local-trust principal has no human-session marker.
 * A new sensitive route is added to CRITICAL_ROUTES (the list is the drift guard).
 */
const CRITICAL_ROUTES: CriticalRoute[] = [
  { method: 'POST', path: '/api/v1/user/voice-accesses', interceptors: [RequireVoiceOwnerInterceptor, RejectApiTokenInterceptor] },
  { method: 'PUT', path: '/api/v1/user/voice-accesses/:id', interceptors: [RequireVoiceOwnerInterceptor, RejectApiTokenInterceptor] },
  { method: 'DELETE', path: '/api/v1/user/voice-accesses/:id', interceptors: [RequireVoiceOwnerInterceptor, RejectApiTokenInterceptor] },
];

/** Write routes deliberately left without a principal guard, with the reason (anything else must be in CRITICAL_ROUTES). */
const OPEN_ROUTES: OpenRoute[] = [
  { method: 'POST', path: '/api/v1/user/voice-accesses/:id/tts', reason: 'dispatch with one of the caller\'s own accesses (ownership checked): the stored key is used server-side, never revealed, changed or redirected; same exposure as POST /voice/tts' },
  { method: 'POST', path: '/api/v1/user/voice-accesses/:id/stt', reason: 'dispatch with one of the caller\'s own accesses (ownership checked): the stored key is used server-side, never revealed, changed or redirected; same exposure as POST /voice/stt' },
];

describe('UserVoiceAccessController principal guards', () => {
  it('keeps every critical route behind the API-token refusal', () => {
    expect(findRouteMismatches(UserVoiceAccessController, CRITICAL_ROUTES)).toEqual([]);
  });

  it('classifies every write route as guarded or deliberately open', () => {
    expect(findUnclassifiedWriteRoutes(UserVoiceAccessController, CRITICAL_ROUTES, OPEN_ROUTES)).toEqual([]);
  });
});
