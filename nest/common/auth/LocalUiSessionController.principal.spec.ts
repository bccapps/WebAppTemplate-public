/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { type CriticalRoute, findUnclassifiedWriteRoutes, type OpenRoute } from '../testing/controllerInterceptors.testkit';
import { LocalUiSessionController } from './LocalUiSessionController';

const CRITICAL_ROUTES: CriticalRoute[] = [];

/** Write routes deliberately left without a principal guard, with the reason (anything else must be in CRITICAL_ROUTES). */
const OPEN_ROUTES: OpenRoute[] = [
  {
    method: 'POST',
    path: '/api/v1/local-ui/session',
    reason: '@Public by nature: exchanges the one-time boot code for the interface session, before any principal; answers only a genuine local-trust request of an app started with LOCAL_UI_BOOT_ANCHOR',
  },
  {
    method: 'POST',
    path: '/api/v1/local-ui/session/renew',
    reason: '@Public by nature: rotates the interface session token it carries; answers only a genuine local-trust request with a live token',
  },
];

describe('LocalUiSessionController principal guards', () => {
  it('classifies every write route as guarded or deliberately open', () => {
    expect(findUnclassifiedWriteRoutes(LocalUiSessionController, CRITICAL_ROUTES, OPEN_ROUTES)).toEqual([]);
  });
});
