/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from '../common/CommonModule';
import { ConfigVapidKeySource } from './adapters/ConfigVapidKeySource';
import { CryptInteractionSecretStore } from './adapters/CryptInteractionSecretStore';
import { EventStreamRealtime } from './adapters/EventStreamRealtime';
import { LoggerAuditSink } from './adapters/LoggerAuditSink';
import { InteractionAdminController } from './controllers/InteractionAdminController';
import { InteractionMeController } from './controllers/InteractionMeController';
import { TelegramWebhookController } from './controllers/TelegramWebhookController';
import { InteractionErrorInterceptor } from './errors/InteractionHttpException';
import { INTERACTION_ENTITIES } from './interactionEntities';
import { resolveInteractionOptions, type InteractionModuleOptions } from './interactionOptions';
import { BrowserChannelProvider } from './providers/browser/BrowserChannelProvider';
import { WebPushSender } from './providers/browser/WebPushSender';
import { TelegramBotClient } from './providers/telegram/TelegramBotClient';
import { TelegramBotFleet } from './providers/telegram/TelegramBotFleet';
import { TelegramBotStateStore } from './providers/telegram/TelegramBotStateStore';
import { TelegramChannelProvider } from './providers/telegram/TelegramChannelProvider';
import { TelegramInboundRegistry } from './providers/telegram/TelegramInboundRegistry';
import { TelegramLinkService } from './providers/telegram/TelegramLinkService';
import { TelegramSender } from './providers/telegram/TelegramSender';
import { TelegramUpdateHandler } from './providers/telegram/TelegramUpdateHandler';
import { RequireHumanSessionInterceptor } from './controllers/interactionRequest';
import { InteractionChannelService } from './services/InteractionChannelService';
import { InteractionConfig } from './services/InteractionConfig';
import { InteractionDeliveryService } from './services/InteractionDeliveryService';
import { InteractionInboxService } from './services/InteractionInboxService';
import { InteractionKeyService } from './services/InteractionKeyService';
import { InteractionMaintenanceService } from './services/InteractionMaintenanceService';
import { INTERACTION_BUILT_IN_PROVIDERS, InteractionProviderRegistry } from './services/InteractionProviderRegistry';
import { InteractionPrefService } from './services/InteractionPrefService';
import { InteractionRenderer } from './services/InteractionRenderer';
import { InteractionBackground, InteractionHooks, InteractionSignals } from './services/InteractionRuntime';
import { InteractionSendQuotaService } from './services/InteractionSendQuotaService';
import { InteractionTicketCardStore } from './services/InteractionTicketCardStore';
import { InteractionTicketService } from './services/InteractionTicketService';
import { UserInteractionService } from './services/UserInteractionService';
import { InteractionAccountErasure } from './services/InteractionAccountErasure';
import type { InteractionChannelProvider } from './types/providerTypes';
import {
  INTERACTION_AUDIT,
  INTERACTION_DIRECTORY,
  INTERACTION_EXTRA_PROVIDERS,
  INTERACTION_OPTIONS,
  INTERACTION_REALTIME,
  INTERACTION_SECRET_STORE,
  INTERACTION_STEP_UP,
  INTERACTION_VAPID_KEYS,
} from './types/ports';

/** The services of the module (no controller), shared by `forRoot` and the conformance testkit. */
const CORE_SERVICES: Provider[] = [
  InteractionConfig,
  InteractionKeyService,
  InteractionBackground,
  InteractionSignals,
  InteractionHooks,
  InteractionRenderer,
  InteractionSendQuotaService,
  InteractionPrefService,
  InteractionProviderRegistry,
  InteractionChannelService,
  InteractionInboxService,
  InteractionDeliveryService,
  InteractionTicketCardStore,
  InteractionTicketService,
  UserInteractionService,
  // Found by `user` at account closure (`@AccountErasureParticipant()`): `forgetUser` without any import between the two modules.
  InteractionAccountErasure,
  InteractionMaintenanceService,
  InteractionErrorInterceptor,
  RequireHumanSessionInterceptor,
  WebPushSender,
  BrowserChannelProvider,
  TelegramBotClient,
  TelegramBotStateStore,
  TelegramLinkService,
  TelegramSender,
  TelegramInboundRegistry,
  TelegramUpdateHandler,
  TelegramBotFleet,
  TelegramChannelProvider,
];

/** What other modules may inject (the module is global: they never import it). */
export const INTERACTION_EXPORTS = [UserInteractionService, TelegramInboundRegistry, InteractionHooks, InteractionTicketCardStore, INTERACTION_SECRET_STORE];

function port<T>(token: symbol, custom: Type<T> | undefined, fallback: Type<T>): Provider[] {
  const impl = custom ?? fallback;
  return [impl, { provide: token, useExisting: impl }];
}

/** Every provider of `forRoot(options)` (ports, built-in and app providers, services). */
export function interactionProviders(options: InteractionModuleOptions): Provider[] {
  if (!options?.directory) throw new Error('[interaction] InteractionModule.forRoot needs a `directory` (InteractionDirectory of the app)');
  const runtime = resolveInteractionOptions(options);
  const extras = options.providers ?? [];
  return [
    { provide: INTERACTION_OPTIONS, useValue: runtime },
    options.directory,
    { provide: INTERACTION_DIRECTORY, useExisting: options.directory },
    ...port(INTERACTION_SECRET_STORE, options.ports?.secretStore, CryptInteractionSecretStore),
    ...port(INTERACTION_REALTIME, options.ports?.realtime, EventStreamRealtime),
    ...port(INTERACTION_AUDIT, options.ports?.audit, LoggerAuditSink),
    ...port(INTERACTION_VAPID_KEYS, options.ports?.vapidKeys, ConfigVapidKeySource),
    ...(options.ports?.stepUp ? [options.ports.stepUp, { provide: INTERACTION_STEP_UP, useExisting: options.ports.stepUp }] : [{ provide: INTERACTION_STEP_UP, useValue: null }]),
    ...extras,
    { provide: INTERACTION_EXTRA_PROVIDERS, useFactory: (...list: InteractionChannelProvider[]) => list, inject: extras },
    {
      provide: INTERACTION_BUILT_IN_PROVIDERS,
      useFactory: (browser: BrowserChannelProvider, telegram: TelegramChannelProvider): InteractionChannelProvider[] => [
        ...(runtime.builtIn.browser ? [browser] : []),
        ...(runtime.builtIn.telegram ? [telegram] : []),
      ],
      inject: [BrowserChannelProvider, TelegramChannelProvider],
    },
    ...CORE_SERVICES,
  ];
}

/** The controllers `routes` turns on (default: user and admin routes, no Telegram webhook). */
export function interactionControllers(options: InteractionModuleOptions): Type<unknown>[] {
  const { routes } = resolveInteractionOptions(options);
  return [...(routes.user ? [InteractionMeController] : []), ...(routes.admin ? [InteractionAdminController] : []), ...(routes.telegramWebhook ? [TelegramWebhookController] : [])];
}

/**
 * Per-user interaction channels and questions (contract 04). ONE call at the root of the app (its plugin, or its
 * `AppModule`), global: consumers inject `UserInteractionService` and never import this module. No
 * `ScheduleModule.forRoot()` here (the loops are timers on worker processes).
 */
@Module({})
export class InteractionModule {
  static forRoot(options: InteractionModuleOptions): DynamicModule {
    return {
      module: InteractionModule,
      global: true,
      imports: [CommonModule, TypeOrmModule.forFeature(INTERACTION_ENTITIES), ...(options?.imports ?? [])],
      controllers: interactionControllers(options),
      providers: interactionProviders(options),
      exports: INTERACTION_EXPORTS,
    };
  }
}
