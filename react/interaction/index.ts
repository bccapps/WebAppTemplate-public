/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Public surface of the front module.

export * from './types/interactionTypes';
export { interactionApi, toApiError } from './services/interactionApi';
export { decideInappDisplay, displayNotice, notificationTag, shouldPromptForPermission, type BrowserPermission, type NoticeSurface } from './pure/inappDisplay';
export { renderText, fillParams } from './pure/text';
export {
  useInteractionInbox,
  useInteractionTicket,
  useInteractionChannels,
  useInteractionPrefs,
  useInteractionAdminChannels,
  useBrowserNotificationPermission,
  useWebPush,
  registerInteractionStepUp,
  useHasInteractionStepUp,
  useInboxStream,
  type InteractionStepUpHandler,
} from './hooks/interactionHooks';
export { enableWebPush, disableWebPush, isWebPushSupported, requestBrowserPermission } from './browser/browserNotifications';
export { useWebPushSessionGuard } from './browser/webPushSession';
export { createWebPushSessionTracker, webPushActionOnSessionChange, type SessionUserId } from './pure/webPushSession';
export { InteractionHost } from './components/InteractionHost';
export { InteractionQuestionModal } from './components/InteractionQuestionModal';
export { InteractionInboxBadge, InteractionInboxPanel, BrowserNotificationPrompt } from './components/InteractionInbox';
export { InteractionChannelsPanel, InteractionChannelsAdminPanel, InteractionPrefsPanel } from './components/InteractionPanels';
export { registerInteractionChannelCard, type InteractionChannelCardProps } from './components/channelCardRegistry';
export { installInteractionPushHandlers } from './sw/interactionPush';
export { createInteractionPlugin, plugin, type InteractionPluginOptions } from './plugin';
