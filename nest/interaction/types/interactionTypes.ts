/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Vocabulary of the interaction module (contract 04 §4.1-§4.5, capabilities revised in §20, fresh proof in §21).
// Signatures only: no logic here.

export type InteractionCategory = 'security' | 'approval' | 'info';
export const INTERACTION_CATEGORIES: readonly InteractionCategory[] = ['security', 'approval', 'info'];

/** `critical`: an `info` notice passes the quiet hours when the user keeps `critical_bypass` on. */
export type InteractionPriority = 'normal' | 'critical';

/**
 * 04 §20: `notify` (inform), `open` (a click leads into the app, to the question), `reply` (a direct answer from the
 * channel: the in-app modal, Telegram buttons). A question is always answered in the app or through a `reply` channel.
 */
export type InteractionCapability = 'notify' | 'open' | 'reply';

/**
 * 04 §22 « règle de capacité `proof` »: how a channel can bring the recent proof a `freshProof` question needs.
 * `in_app`: the channel's interface is inside the authenticated app (the in-app modal, an app's own messaging), the
 * step-up happens there and the answer carries the proof id; `link`: an external channel (Telegram, a browser
 * notification, Prowl) only LEADS into the app, no press of it is ever a proof; `code`: a one-time code typed in the
 * channel, not retained in v1 (a provider declaring it is refused unless `forRoot({ allowCodeProof: true })`, and even
 * then it never answers a `freshProof` question in v1).
 */
export type InteractionProof = 'in_app' | 'link' | 'code';
export const INTERACTION_PROOFS: readonly InteractionProof[] = ['in_app', 'link', 'code'];

export type BuiltInChannelKind = 'inapp' | 'browser' | 'telegram' | 'email' | 'webhook';
export type ChannelKind = BuiltInChannelKind | (string & {});

/** A kind as stored: lower-case, 2-16 characters; `inapp` is reserved and never stored. */
export const CHANNEL_KIND_PATTERN = /^[a-z][a-z0-9_]{1,15}$/;

/** A key translated in the recipient's language (named `{param}` placeholders), or an already rendered text. */
export type InteractionText = { key: string; params?: Record<string, string | number> } | { raw: string };

export interface UserNotice {
  /** `mcp.credential.suspended`: /^[a-z0-9]+(\.[a-z0-9_]+){1,4}$/ */
  type: string;
  /** `mcp-access`, `tradekong.alerts`: 40 characters at most. */
  source: string;
  category: InteractionCategory;
  priority?: InteractionPriority;
  /** Rendered: 120 characters at most. */
  title: InteractionText;
  /** Rendered: 1 000 characters at most. The app's summary, never a raw tool argument. */
  body?: InteractionText;
  /** RELATIVE path of the app (`/mcp/credentials/…`), made absolute with the site URL. */
  url?: string;
  /** 128 characters at most; same key = at most one delivery per channel (invariant 3). Absent = random. */
  dedupKey?: string;
  /** 2 KB at most, non-sensitive ids, in-app only. */
  data?: Record<string, string | number | boolean>;
}

export type InteractionActionStyle = 'primary' | 'danger' | 'neutral';

export interface InteractionAction {
  /** /^[a-z][a-z0-9_]{0,15}$/ */
  id: string;
  label: InteractionText;
  style: InteractionActionStyle;
}

export interface InteractionSummary {
  title: InteractionText;
  body?: InteractionText;
  fields?: Array<{ label: InteractionText; value: string }>;
  /** Relative path of the app where the question is shown in context. */
  url?: string;
}

export interface InteractionQuestion {
  /** Key of the `onAnswer` handler (`mcp.approval`). */
  kind: string;
  source: string;
  /** Unique per (source, correlationId): a second `ask` returns the existing ticket. */
  correlationId: string;
  category: 'approval' | 'security';
  /** 4 KB at most once serialized, masked. */
  summary: InteractionSummary;
  /** 2 to 4. */
  actions: InteractionAction[];
  expiresAt: Date;
  /** Default: every channel able to `reply`. */
  answerableFrom?: ChannelKind[];
  /**
   * 04 §21, §22: the answer needs a recent proof of identity (`InteractionStepUpPort`). Such a question is answerable
   * only from the channels whose `proof` is `in_app` (the in-app modal, an app's own in-app channel), with a valid proof;
   * a `link` channel (Telegram, browser) only leads into the app. Without the port, `ask()` throws `STEP_UP_UNAVAILABLE`.
   */
  freshProof?: boolean;
}

export type TicketStatus = 'open' | 'answered' | 'expired' | 'cancelled';
export type ClosedTicketStatus = Exclude<TicketStatus, 'open'>;

export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'skipped' | 'duplicate';

export interface DeliveryEntry {
  kind: ChannelKind;
  status: DeliveryStatus;
  /** A code of 04 §12.3, never a free message. */
  code: string | null;
}

export interface DeliveryReport {
  userId: number;
  /** The `interaction_notice` row (in-app); null when the user is inactive or the notice was a duplicate. */
  noticeId: string | null;
  outcome: 'delivered' | 'inapp_only' | 'inactive';
  deliveries: DeliveryEntry[];
}

export interface InteractionTicket {
  /** uuid, never inside a Telegram button. */
  id: string;
  /**
   * The question it asks (`kind`, `source`, `correlationId` of `ask`): lets an app's own reply channel apply its rules to the question
   * before answering it (C2, AgentHub's messaging). Server side only, never in a DTO.
   */
  kind: string;
  source: string;
  correlationId: string;
  status: TicketStatus;
  expiresAt: Date;
  recipients: number[];
  /** State when `ask()` returns: in-app delivered, external channels `queued`. */
  deliveries: DeliveryReport[];
}

/** The outcome handed to the `onAnswer` handler of the question's kind (at least once, idempotent by `ticketId`). */
export interface InteractionAnswer {
  ticketId: string;
  kind: string;
  source: string;
  correlationId: string;
  status: ClosedTicketStatus;
  /** Non-null iff `answered`. */
  actionId: string | null;
  via: ChannelKind | null;
  answeredBy: number | null;
  at: Date;
}

export type InteractionAnswerHandler = (answer: InteractionAnswer) => Promise<void>;

/** `onAnswer` options (review F3): `source` binds the kind to the questions of ONE source (`ask` of another is refused). */
export interface InteractionAnswerOptions {
  source?: string;
}

/** What apps (and the `McpInteractionPort` adapter) see: `UserInteractionService` implements it. */
export interface UserInteractionApi {
  notify(userId: number, notice: UserNotice): Promise<DeliveryReport>;
  notifyMany(userIds: number[], notice: UserNotice): Promise<DeliveryReport[]>;
  notifyAdmins(notice: UserNotice): Promise<DeliveryReport[]>;
  ask(recipients: number | number[], question: InteractionQuestion): Promise<InteractionTicket>;
  cancel(source: string, correlationId: string, reason: string): Promise<boolean>;
  getTicket(ticketId: string): Promise<InteractionTicket | null>;
  onAnswer(kind: string, handler: InteractionAnswerHandler, options?: InteractionAnswerOptions): () => void;
  reachableKinds(userId: number, category: InteractionCategory): Promise<ChannelKind[]>;
  forgetUser(userId: number): Promise<void>;
}
