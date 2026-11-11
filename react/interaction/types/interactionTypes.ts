/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Shapes exchanged with `nest/interaction` (contract 04 §11.4). Mirrors the back DTOs; no logic here.

export type InteractionCategory = 'security' | 'approval' | 'info';
export type InteractionText = { key: string; params?: Record<string, string | number> } | { raw: string };
export type InappDisplay = 'toast' | 'browser';
/**
 * 04 §22: how a channel can bring the proof of a `freshProof` question: `in_app` (its interface is inside the app, the
 * step-up happens there), `link` (it only leads into the app: Telegram, browser), `code` (not retained in v1).
 */
export type InteractionProof = 'in_app' | 'link' | 'code';

export interface InteractionChannelDto {
  kind: string;
  id: string | null;
  enabled: boolean;
  adminDisabled: boolean;
  configured: boolean;
  verified: boolean;
  ready: boolean;
  position: number;
  capabilities: string[];
  /** Declared `proof` capability (sent by the server since the C1 hardening; absent from an older server). */
  proof?: InteractionProof;
  view: Record<string, unknown>;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface InteractionChannelSaveDto {
  channel: InteractionChannelDto;
  /** Non-null ONCE (a webhook key at creation or rotation); never a bot token. */
  secret: string | null;
}

export interface ChannelTestResultDto {
  ok: boolean;
  code: string | null;
}

export interface TelegramLinkCodeDto {
  code: string;
  deepLink: string;
  expiresAt: string;
}

/** Owner view of the Telegram channel (`InteractionChannelDto.view`). */
export interface TelegramChannelView {
  mode: 'own' | 'operator';
  allowedModes: Array<'own' | 'operator'>;
  botUsername: string | null;
  tokenSet: boolean;
  inbound: boolean;
  links: Array<{ id: string; label: string | null; source: string; createdAt: string }>;
}

/** Owner view of the browser channel. */
export interface BrowserChannelView {
  subscriptions: number;
  devices: Array<{ id: string; userAgent: string | null; createdAt: string }>;
}

export interface InteractionPrefDto {
  quietHours: { start: string; end: string } | null;
  timezone: string;
  criticalBypass: boolean;
  routing: Record<InteractionCategory, string[] | null>;
  inappDisplay: InappDisplay | null;
  effectiveInappDisplay: InappDisplay;
}

export interface InteractionPrefBody {
  quietHours?: { start: string; end: string } | null;
  timezone?: string | null;
  criticalBypass?: boolean;
  routing?: Partial<Record<InteractionCategory, string[] | null>>;
  inappDisplay?: InappDisplay | null;
}

export interface InteractionNoticeDto {
  id: string;
  type: string;
  source: string;
  category: InteractionCategory;
  priority: 'normal' | 'critical';
  title: InteractionText;
  body: InteractionText | null;
  url: string | null;
  data: Record<string, string | number | boolean> | null;
  ticketId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface InteractionTicketAction {
  id: string;
  label: InteractionText;
  style: 'primary' | 'danger' | 'neutral';
  allowedHere: boolean;
}

export interface InteractionTicketDto {
  id: string;
  kind: string;
  source: string;
  category: InteractionCategory;
  summary: { title: InteractionText; body?: InteractionText; fields?: Array<{ label: InteractionText; value: string }>; url?: string };
  actions: InteractionTicketAction[];
  answerableFrom: string[];
  freshProofRequired: boolean;
  stepUpPurpose: string | null;
  status: 'open' | 'answered' | 'expired' | 'cancelled';
  expiresAt: string;
  answeredVia: string | null;
  answeredAt: string | null;
  answeredByMe: boolean;
  createdAt: string;
}

export interface InboxDto {
  tickets: InteractionTicketDto[];
  notices: InteractionNoticeDto[];
  unread: number;
}

export interface InteractionChannelAdminDto {
  id: string;
  owner: { userId: number; name: string | null };
  kind: string;
  enabled: boolean;
  adminDisabled: boolean;
  configured: boolean;
  verified: boolean;
  meta: Record<string, string | number | boolean | null>;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebPushSubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

/** Error codes of 04 §12 (one `interaction.errors.<CODE>` label each). */
export const INTERACTION_ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_CONFIG',
  'VERIFICATION_FAILED',
  'CHANNEL_NOT_ALLOWED',
  'STEP_UP_REQUIRED',
  'NOT_FOUND',
  'ADMIN_DISABLED',
  'KIND_DISABLED',
  'NOT_CONFIGURED',
  'BOT_IN_USE',
  'ALREADY_ANSWERED',
  'CANCELLED',
  'EMAIL_UNAVAILABLE',
  'EXPIRED',
  'ROUTE_REQUIRED',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
] as const;
export type InteractionErrorCode = (typeof INTERACTION_ERROR_CODES)[number] | 'UNKNOWN';

/** A failed call, as `interactionApi` rejects it. */
export interface InteractionApiError {
  code: InteractionErrorCode;
  status: number;
  details: Record<string, unknown> | null;
}
