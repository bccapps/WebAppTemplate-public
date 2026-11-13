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

/** An answer about to be decided, as an answer gate sees it (never the question's text). */
export interface PendingAnswer {
  ticketId: string;
  kind: string;
  source: string;
  correlationId: string;
  actionId: string;
  via: ChannelKind;
  answeredBy: number;
  /**
   * The question is a `freshProof` one: `apply` runs only once the answerer's step-up proof (purpose
   * `interaction.ticket:<ticketId>`) was consumed (step 4 below); `check` runs before, with the proof not spent yet.
   * An app with a step-up of its own for the same effect relies on it instead of asking again (C2, AgentHub).
   */
  freshProof: boolean;
}

/**
 * C2 (AgentHub): makes the answers of one question kind EFFECTFUL and atomic with the app's own state, so that a ticket is
 * never `answered` when the app refused the answer. Order (human review required):
 * 1. the module's own checks (recipient, active, channel, action, open and not expired);
 * 2. `check` — no effect: a refusal leaves the ticket untouched and spends nothing (a step-up proof included);
 * 3. the ticket is CLAIMED (conditional UPDATE, `dispatch_status = 'applying'` until `now + timeout + 30 s`); a concurrent
 *    answer waits a few seconds, then gets `IN_PROGRESS`; the expiry sweep and `cancel` leave a live claim alone;
 * 4. a `freshProof` question: the proof is consumed by the claimant only (invalid: claim released, `STEP_UP_REQUIRED`);
 * 5. `apply` — the effect, bounded by `timeoutMs`; a throw releases the claim (ticket open again, the error reaches the
 *    answerer: an `InteractionError` as is, anything else `ANSWER_REFUSED { reason: <its code> }`); a timeout KEEPS the
 *    claim until it lapses (the effect may still land) and answers `ANSWER_REFUSED { reason: 'TIMEOUT' }`;
 * 6. success: the conditional UPDATE `open → answered` bound to this claim, judged without `expires_at` (the effect is
 *    done). The outcome then reaches the handler as usual.
 * A claimant that dies between 3 and 6 leaves an OPEN ticket whose claim lapses (the next answer, the sweep or a
 * cancellation take over); the app reconciles its open tickets with its state through `openTickets(source)`.
 */
export interface InteractionAnswerGate {
  check?(answer: PendingAnswer): Promise<void>;
  apply(answer: PendingAnswer): Promise<void>;
  /** Bound of `apply`, 1 s to 120 s (default 30 s); the claim lasts it plus 30 s. */
  timeoutMs?: number;
  /**
   * An error of `apply` whose effect may still land (the app timed out waiting for its own system): treated like a timeout of `apply` — the
   * claim is KEPT until it lapses (the ticket is not reopened for a second answer) and the answerer gets `ANSWER_REFUSED { reason }`.
   */
  isUncertain?(error: unknown): boolean;
}

/**
 * `onAnswer` options. `source` binds the kind to the questions of ONE source (review F3: an `ask` of another is refused);
 * `gate` makes its answers effectful (above).
 */
export interface InteractionAnswerOptions {
  source?: string;
  gate?: InteractionAnswerGate;
}

/** An open ticket of a source (`openTickets`): its question's correlation and whether an answer is being applied now. */
export interface OpenTicketRef {
  ticketId: string;
  correlationId: string;
  applying: boolean;
  /** Its recipients now (`revokeRecipient` withdraws one). */
  recipients: number[];
  /** Whether an answer needs a recent proof (an app whose own rule tightened may cancel and ask again). */
  freshProof: boolean;
}

/**
 * `reopen(source, correlationId)`: `reopened` (cancelled → open, recipients notified again), `already_open` (nothing done: idempotent),
 * `not_found`, `answered` / `expired` (never reopened), `no_recipient` (nobody left, or no active recipient), `busy` (the cancellation is
 * still being handed to the `onAnswer` handler: try again later).
 */
export type ReopenOutcome = 'reopened' | 'already_open' | 'not_found' | 'answered' | 'expired' | 'no_recipient' | 'busy';

export interface ReopenOptions {
  /** A new expiry, in (now, now + `interaction_askMaxTtlSeconds`]; required when the stored one has passed. Default: the stored one. */
  expiresAt?: Date;
}

export interface ReopenResult {
  outcome: ReopenOutcome;
  /** The ticket as it stands (`reopened`: with the deliveries of the new notification), `null` when `not_found`. */
  ticket: InteractionTicket | null;
}

/** What apps (and the `McpInteractionPort` adapter) see: `UserInteractionService` implements it. */
export interface UserInteractionApi {
  notify(userId: number, notice: UserNotice): Promise<DeliveryReport>;
  notifyMany(userIds: number[], notice: UserNotice): Promise<DeliveryReport[]>;
  notifyAdmins(notice: UserNotice): Promise<DeliveryReport[]>;
  ask(recipients: number | number[], question: InteractionQuestion): Promise<InteractionTicket>;
  cancel(source: string, correlationId: string, reason: string): Promise<boolean>;
  /** Optional in the contract (an app's own fake may omit it); `UserInteractionService` implements it. */
  reopen?(source: string, correlationId: string, options?: ReopenOptions): Promise<ReopenResult>;
  getTicket(ticketId: string): Promise<InteractionTicket | null>;
  onAnswer(kind: string, handler: InteractionAnswerHandler, options?: InteractionAnswerOptions): () => void;
  reachableKinds(userId: number, category: InteractionCategory): Promise<ChannelKind[]>;
  openTickets(source: string, options?: { correlationId?: string; limit?: number }): Promise<OpenTicketRef[]>;
  revokeRecipient(source: string, correlationId: string, userId: number, reason: string): Promise<boolean>;
  forgetUser(userId: number): Promise<void>;
}
