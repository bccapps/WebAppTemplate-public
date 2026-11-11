/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Extension point of the module (contract 04 §4.6): a channel provider. An app adds a channel by writing a class that
// implements `InteractionChannelProvider`, passing it to `InteractionModule.forRoot({ providers })` and adding its
// `kind` to `interaction_enabledKinds`. Nothing else.

import type { ChannelKind, InteractionAnswer, InteractionCapability, InteractionCategory, InteractionProof } from './interactionTypes';

/** Who acts on a channel: its owner (or an administrator) and the client address of the request. */
export interface ChannelOwner {
  userId: number;
  admin: boolean;
  ip: string | null;
}

/** A configured channel of a user (`interaction_user_channel`), as providers see it. */
export interface StoredChannel {
  id: string;
  userId: number;
  kind: ChannelKind;
  enabled: boolean;
  adminDisabled: boolean;
  position: number;
  /** Non-secret configuration, validated by `configSchema`. */
  config: Record<string, unknown>;
  /** `{ pendingTarget, codeHash, expiresAt, attempts }`, never a code. */
  verification: Record<string, unknown> | null;
  /** Reference into `InteractionSecretStore`. */
  secretId: string | null;
  /**
   * Uniqueness key of the provider (the id of a Telegram bot): unique per kind (index), a clash is `BOT_IN_USE`. It must
   * NEVER be a target (an e-mail address, a URL, a phone number): the unique index would turn `BOT_IN_USE` into an oracle
   * telling one user that another user registered that target.
   */
  externalKey: string | null;
  verifiedAt: Date | null;
}

/** One action button of a question, as a provider renders it. */
export interface RenderedAction {
  index: number;
  id: string;
  label: string;
  style: string;
}

/** A message rendered for one recipient and one channel: masked, cut, in the recipient's language. */
export interface RenderedMessage {
  deliveryId: string;
  userId: number;
  locale: string;
  category: InteractionCategory;
  type: string;
  title: string;
  body: string;
  /** Absolute URL, or null when the site URL is not configured. */
  url: string | null;
  question?: {
    ticketId: string;
    actions: RenderedAction[];
    expiresAt: Date;
    /** True when this channel may answer (capability `reply` and kind in `answerableFrom`). */
    answerable: boolean;
    /** Absolute link into the app (no id of the module in it), null without a site URL. */
    openUrl: string | null;
  };
}

export interface SendContext {
  /** Null for a provider without a row. */
  channel: StoredChannel | null;
  /** A test send (`POST /me/channels/:kind/test`). */
  ping: boolean;
  /** Aborted after `interaction_providerTimeoutMs`. */
  signal: AbortSignal;
}

/** `code`: a code of 04 §12.3 (`TIMEOUT`, `HTTP_<status>`, `TELEGRAM_<status>`, …), never a free message. */
export interface ChannelSendResult {
  ok: boolean;
  code: string | null;
}

/** Readiness of a channel; `code` explains a channel that is not ready (`NOT_CONFIGURED`, `NOT_LINKED`, `NO_SUBSCRIPTION`…). */
export interface ChannelReadiness {
  ready: boolean;
  code: string | null;
}

/** A press of a reply channel, reduced to what the binding check needs (04 §8.3). */
export interface ParsedReply {
  kind: ChannelKind;
  cardKey: string;
  actionIndex: number;
  signatureValid: boolean;
  binding: Record<string, string>;
  channelUserRef: string;
}

/** A card (a question sent with buttons) to redraw once its ticket is closed. */
export interface TicketCardRef {
  ticketId: string;
  cardKey: string;
  kind: ChannelKind;
  binding: Record<string, string>;
  lang: string;
}

/** What `configure` returns: the channel to store and, at most once, a secret to show its owner (a webhook key). */
export interface ChannelConfigureResult {
  channel: StoredChannel;
  secretOnce: string | null;
  /**
   * Optional: what the change abandons (links of a previous bot…), run by the channel service ONLY once `channel` was
   * written. A refused write (`BOT_IN_USE`, `ADMIN_DISABLED`, a concurrent write it yields to) never runs it, so a
   * provider must not destroy anything in `configure` itself.
   */
  afterSave?: () => Promise<void>;
}

export interface InteractionChannelProvider<Cfg = unknown> {
  readonly kind: ChannelKind;
  readonly capabilities: ReadonlySet<InteractionCapability>;
  /**
   * 04 §22: how this channel can bring the proof of a `freshProof` question. `in_app` = its interface is inside the
   * authenticated app (it passes `stepUpProof` with the answer); `link` = an external channel that only leads into the
   * app (Telegram, browser); `code` = refused at registration unless `forRoot({ allowCodeProof: true })` (not in v1).
   */
  readonly proof: InteractionProof;
  /** `parse` throws `InteractionError('INVALID_CONFIG', { field, reason })`. */
  readonly configSchema: { parse(input: unknown): Cfg; secretFields: readonly string[] };
  readonly requiresVerification: boolean;

  configure(owner: ChannelOwner, input: unknown, current: StoredChannel | null): Promise<ChannelConfigureResult>;
  verify(owner: ChannelOwner, channel: StoredChannel, proof: unknown): Promise<StoredChannel>;
  /** Configured, verified, links present… */
  isReady(channel: StoredChannel): Promise<boolean>;
  /** Optional: readiness with the reason (`isReady` + `NOT_CONFIGURED` otherwise). */
  readiness?(channel: StoredChannel): Promise<ChannelReadiness>;
  /** Must not throw; a throw is caught anyway (invariant 8). */
  send(ctx: SendContext, message: RenderedMessage): Promise<ChannelSendResult>;
  /** Redraws a card « answered / expired / cancelled », without buttons. */
  closeCard?(card: TicketCardRef, outcome: InteractionAnswer): Promise<void>;
  /** Raw inbound input → an authenticable press. */
  parseReply?(raw: unknown): Promise<ParsedReply | null>;
  /** The owner's own view: their targets, never a secret. */
  ownerView(channel: StoredChannel): Promise<Record<string, unknown>>;
  /** Administrators' view: metadata without any target. */
  adminView(channel: StoredChannel): Promise<Record<string, string | number | boolean | null>>;
  onRemove?(channel: StoredChannel): Promise<void>;
  /** Optional: a new signing secret shown once (a webhook key, `POST /me/channels/webhook/secret`). */
  rotateSecret?(owner: ChannelOwner, channel: StoredChannel): Promise<ChannelConfigureResult>;
}

/** The render hook of `InteractionHooks.registerRenderHook`: may rewrite a rendered message per channel. */
export type InteractionRenderHook = (ctx: { kind: ChannelKind; message: RenderedMessage }) => RenderedMessage;
