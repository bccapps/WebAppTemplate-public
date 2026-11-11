/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Guard drift of the module's controllers (common `controllerInterceptors.testkit.ts`): every write route is a written decision.

import { describe, expect, it } from '@jest/globals';
import { RequireUserInterceptor } from '../../common/auth/RequireUserInterceptor';
import { AdminOnlyInterceptor } from '../../common/interceptors/AdminOnlyInterceptor';
import { RejectApiTokenInterceptor } from '../../common/interceptors/RejectApiTokenInterceptor';
import { findRouteMismatches, findShadowedRoutes, findUnclassifiedWriteRoutes, routesOf, type CriticalRoute, type OpenRoute } from '../../common/testing/controllerInterceptors.testkit';
import { InteractionErrorInterceptor } from '../errors/InteractionHttpException';
import { InteractionAdminController } from './InteractionAdminController';
import { RequireHumanSessionInterceptor } from './interactionRequest';
import { InteractionMeController } from './InteractionMeController';
import { TelegramWebhookController } from './TelegramWebhookController';

const writes = (controller: Parameters<typeof routesOf>[0]) => routesOf(controller).filter((route) => !['GET', 'HEAD', 'OPTIONS'].includes(route.method));
const every = (controller: Parameters<typeof routesOf>[0], interceptors: CriticalRoute['interceptors']): CriticalRoute[] =>
  routesOf(controller).map((route) => ({ method: route.method as CriticalRoute['method'], path: route.path, interceptors }));

describe('interaction controllers — every write route is classified', () => {
  it('/me: a human session only, on every route (reads included)', () => {
    const critical = every(InteractionMeController, [RequireUserInterceptor, RequireHumanSessionInterceptor, InteractionErrorInterceptor]);
    expect(writes(InteractionMeController).length).toBeGreaterThanOrEqual(13);
    expect(findRouteMismatches(InteractionMeController, critical)).toEqual([]);
    expect(findUnclassifiedWriteRoutes(InteractionMeController, critical, [])).toEqual([]);
    expect(findShadowedRoutes(InteractionMeController)).toEqual([]);
  });

  it('/admin: an administrator, never an API token, on every route', () => {
    const critical = every(InteractionAdminController, [AdminOnlyInterceptor, RejectApiTokenInterceptor, InteractionErrorInterceptor]);
    expect(findRouteMismatches(InteractionAdminController, critical)).toEqual([]);
    expect(findUnclassifiedWriteRoutes(InteractionAdminController, critical, [])).toEqual([]);
  });

  it('the Telegram webhook stays open: Telegram calls it, the secret header of the bot is its authentication', () => {
    const open: OpenRoute[] = [{ method: 'POST', path: '/api/v1/interaction/telegram/webhook/:botRef/:botId', reason: 'Telegram webhook: X-Telegram-Bot-Api-Secret-Token compared in constant time before any read, 404 otherwise' }];
    expect(findUnclassifiedWriteRoutes(TelegramWebhookController, [], open)).toEqual([]);
  });
});
