/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Public surface of the module: what an app (or another module) may import.

export { InteractionModule, interactionControllers, interactionProviders, INTERACTION_EXPORTS } from './InteractionModule';
export type { InteractionModuleOptions, InteractionRuntimeOptions } from './interactionOptions';
export type { InteractionPluginOptions } from './plugin';
export { INTERACTION_ENTITIES } from './interactionEntities';
export { interactionConfigSchema, INTERACTION_MODULE_ID } from './interactionConfigSchema';
export * from './types/interactionTypes';
export * from './types/providerTypes';
export * from './types/ports';
export { InteractionError, INTERACTION_ERRORS, isInteractionError, type InteractionErrorCode } from './errors/InteractionError';
export { InteractionHttpException, InteractionErrorInterceptor } from './errors/InteractionHttpException';
export { UserInteractionService, type ProviderAnswerInput } from './services/UserInteractionService';
export { InteractionHooks } from './services/InteractionRuntime';
export { InteractionTicketCardStore } from './services/InteractionTicketCardStore';
export { TelegramInboundRegistry, type TelegramInboundContext, type TelegramCallbackHandler, type TelegramMessageHandler } from './providers/telegram/TelegramInboundRegistry';
export { CryptInteractionSecretStore } from './adapters/CryptInteractionSecretStore';
export { EventStreamRealtime, INTERACTION_INBOX_TOPIC } from './adapters/EventStreamRealtime';
export { maskKnownSecrets, SECRET_MASK } from './utils/maskKnownSecrets';
export { assertReachable, guardedRequest, isBlockedAddress, validateTargetUrl, NetGuardError, type AddressGuard } from './utils/netGuard';
export { DEFAULT_PUSH_HOSTS, isAllowedPushEndpoint } from './pure/pushHosts';
