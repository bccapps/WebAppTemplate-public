/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Ports of the module (contract 04 §4.7, step-up revised in §21): the module never imports the private `user` module;
// the app plugs these in through `InteractionModule.forRoot({ directory, ports })`.

/** Mandatory, provided by the app (about 20 lines: active, admin, administrators, names, verified e-mail, language). */
export interface InteractionDirectory {
  isActive(userId: number): Promise<boolean>;
  isAdmin(userId: number): Promise<boolean>;
  adminUserIds(): Promise<number[]>;
  /** Administrators' views only. */
  displayNames(userIds: number[]): Promise<Map<number, string>>;
  /** Fallback: `USER_CONTACT.emailOf`. */
  verifiedEmailOf?(userId: number): Promise<string | null>;
  /** Fallback: `USER_CONTACT.localeOf`, then the default language. */
  localeOf?(userId: number): Promise<string | null>;
}

/**
 * Per-row secrets with an owner check. Default: `CryptInteractionSecretStore` (`interaction_secret`, encrypted by
 * `CryptService` with one namespace per row, failing closed).
 */
export interface InteractionSecretStore {
  put(ownerUserId: number | null, kind: string, value: string): Promise<string>;
  rotate(id: string, ownerUserId: number | null, value: string): Promise<void>;
  /** Server side only; another owner ⇒ `NOT_FOUND`; unreadable ⇒ `SECRET_UNREADABLE`. */
  reveal(id: string, ownerUserId: number | null): Promise<string>;
  remove(id: string): Promise<void>;
}

export type InteractionRealtimeEventType = 'notice' | 'ticket.opened' | 'ticket.closed' | 'channels.changed';

/** Invalidation only: never a text (the stream may go through Redis). */
export interface InteractionRealtimeEvent {
  type: InteractionRealtimeEventType;
  id?: string;
  data?: Record<string, string>;
}

/** Default: `EventStreamRealtime` (topic `interaction.inbox`, audience `{ userId }`). */
export interface InteractionRealtimePort {
  publish(userId: number, event: InteractionRealtimeEvent): void;
}

export interface InteractionAuditEntry {
  /** `channel.configure`, `channel.admin_disable`, `telegram.link_code`, `ticket.answer`, `ticket.answer_refused`… */
  action: string;
  actor: { userId: number | null; admin: boolean };
  ownerUserId: number;
  /** The channel kind (for an answer: the channel it came through, `via`). */
  kind: string;
  at: Date;
  /** Answers: the ticket's id, the question kind, its source and the action chosen. Never the question's text. */
  ticket?: { id: string | null; kind: string | null; source: string | null; actionId: string | null };
  /** A refusal's code (`STEP_UP_REQUIRED`, `ALREADY_ANSWERED`…). */
  code?: string | null;
}

/** Default: the Nest log (codes and ids, never a target). */
export interface InteractionAuditSink {
  record(entry: InteractionAuditEntry): Promise<void>;
}

/** A way a user can prove they are present now (04 §21.3). */
export type StepUpMethod = 'wallet' | 'totp' | 'google' | 'email_code';

/**
 * 04 §21.6: declared here, implemented by `UserStepUpService` in the private `user` module (lot S). The module only
 * calls `methods` (to tell the front what it may offer) and `consume` (atomic, single use, bound to `purpose`, which
 * is `stepUpPurposeOf(ticketId)`). `begin` / `complete` are served by the user module's own routes.
 */
export interface InteractionStepUpPort {
  methods(userId: number): Promise<StepUpMethod[]>;
  begin(userId: number, method: StepUpMethod, purpose: string, request?: unknown): Promise<Record<string, unknown>>;
  complete(userId: number, method: StepUpMethod, purpose: string, response: unknown, request?: unknown): Promise<{ proofId: string }>;
  /** True once, for an unexpired proof of `userId` issued for exactly `purpose`; false otherwise (never throws for a bad proof). */
  consume(proofId: string, purpose: string, userId: number): Promise<boolean>;
}

/** Default: configuration keys generated on first use (`interaction_vapidPublicKey`, `interaction_vapidPrivateKey`). */
export interface VapidKeySource {
  keys(): Promise<{ publicKey: string; privateKey: string; subject: string }>;
}

export const INTERACTION_DIRECTORY = Symbol('INTERACTION_DIRECTORY');
export const INTERACTION_SECRET_STORE = Symbol('INTERACTION_SECRET_STORE');
export const INTERACTION_REALTIME = Symbol('INTERACTION_REALTIME');
export const INTERACTION_AUDIT = Symbol('INTERACTION_AUDIT');
export const INTERACTION_STEP_UP = Symbol('INTERACTION_STEP_UP');
export const INTERACTION_VAPID_KEYS = Symbol('INTERACTION_VAPID_KEYS');
/** The app's channel providers (array), after the built-in ones. */
export const INTERACTION_EXTRA_PROVIDERS = Symbol('INTERACTION_EXTRA_PROVIDERS');
/** Resolved options of `forRoot` (`InteractionRuntimeOptions`). */
export const INTERACTION_OPTIONS = Symbol('INTERACTION_OPTIONS');

/** The purpose a step-up proof must carry to answer a ticket. */
export function stepUpPurposeOf(ticketId: string): string {
  return `interaction.ticket:${ticketId}`;
}
