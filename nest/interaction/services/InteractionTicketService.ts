/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, LessThan, LessThanOrEqual, Not, Repository } from 'typeorm';
import { isUniqueViolation } from '../../common/utils/dbErrors';
import type { InteractionTicketAdminDto } from '../dtos/InteractionTicketAdminDto';
import type { InteractionTicketDto } from '../dtos/InteractionTicketDto';
import { InteractionTicketEntity } from '../entities/InteractionTicketEntity';
import { InteractionTicketRecipientEntity } from '../entities/InteractionTicketRecipientEntity';
import { InteractionUserChannelEntity } from '../entities/InteractionUserChannelEntity';
import { InteractionError } from '../errors/InteractionError';
import { toTicketAdminDto, toTicketDto } from '../mappers/InteractionMapper';
import { BODY_MAX, TITLE_MAX } from '../pure/text';
import { answerableKinds, bringsFreshProof, normalizeRecipients, SOURCE_PATTERN, validateQuestion, type CleanNotice, type CleanQuestion } from '../pure/validation';
import type {
  ChannelKind,
  DeliveryReport,
  InteractionAnswer,
  InteractionAnswerGate,
  InteractionAnswerHandler,
  InteractionAnswerOptions,
  InteractionQuestion,
  InteractionTicket,
  OpenTicketRef,
  PendingAnswer,
} from '../types/interactionTypes';
import { INTERACTION_AUDIT, INTERACTION_DIRECTORY, INTERACTION_REALTIME, INTERACTION_STEP_UP, stepUpPurposeOf } from '../types/ports';
import type { InteractionAuditSink, InteractionDirectory, InteractionRealtimePort, InteractionStepUpPort } from '../types/ports';
import type { RenderedAction } from '../types/providerTypes';
import { InteractionConfig } from './InteractionConfig';
import { InteractionDeliveryService, type DeliveryMeta, type MessageBuilder, type ReservedDelivery } from './InteractionDeliveryService';
import { InteractionInboxService } from './InteractionInboxService';
import { INAPP_KIND, InteractionProviderRegistry } from './InteractionProviderRegistry';
import { InteractionRenderer } from './InteractionRenderer';
import { errorCode, InteractionBackground } from './InteractionRuntime';
import { InteractionTicketCardStore } from './InteractionTicketCardStore';

const MAX_RECIPIENTS = 20;
/** Waits between two hand-overs of an outcome that failed (04 §8.2.5): the 5th failure is final. */
export const DISPATCH_BACKOFF_MS = [10_000, 60_000, 300_000, 1_800_000];
export const DISPATCH_MAX_ATTEMPTS = 5;
/** The hand-over in progress owns the ticket this long; past it, the retry job may take it over (at least once). */
const DISPATCH_LEASE_MS = 60_000;
const SWEEP_BATCH = 200;
const QUESTION_TYPE = 'interaction.question';
const DEFAULT_OPEN_PATH = '/?interaction=inbox';
/** `dispatch_status` of an OPEN `freshProof` ticket while one answer consumes its proof (`answerWithProof`). */
export const PROOF_CLAIM = 'claimed';
/** Lease of that claim; a claimant that died is taken over once it lapses. */
export const CLAIM_MS = 15_000;
/** The step-up port must answer within this (strictly less than the claim's lease); later = an invalid proof. */
const CONSUME_TIMEOUT_MS = 10_000;
const CLAIM_POLL_MS = 25;
/** An answer gate's claim (C2, `InteractionAnswerGate`): `apply` runs under it; the sweep and `cancel` leave it alone while live. */
export const APPLY_CLAIM = 'applying';
/** How much longer than `apply`'s bound a gate's claim lasts (a timed-out `apply` may still land: the claim outlives it). */
export const APPLY_CLAIM_MARGIN_MS = 30_000;
/** How long a concurrent answer waits for a gate's claim before `IN_PROGRESS`. */
export const APPLY_WAIT_MS = 3_000;
const GATE_TIMEOUT_DEFAULT_MS = 30_000;
const GATE_TIMEOUT_MAX_MS = 120_000;
const GATE_CHECK_TIMEOUT_MS = 10_000;
const OPEN_TICKETS_MAX = 500;
const GATE_TIMEOUT_REASON = 'TIMEOUT';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`, or a rejection after `ms` (the promise itself keeps running). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new InteractionError('STEP_UP_REQUIRED')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The channel an answer came through, re-checked in the deciding UPDATE (anything but `inapp`). */
interface ChannelGuard {
  userId: number;
  kind: string;
}

/** A held claim: its marker (`claimed` for a proof, `applying` for a gate) and its token (its end). */
interface HeldClaim {
  marker: string;
  token: Date;
}

/** The marker of a gate's timeout (never shown: the answerer gets `ANSWER_REFUSED { reason: 'TIMEOUT' }`). */
class GateTimeout extends Error {}

function gateWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GateTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** What a gate's refusal becomes for the answerer: an `InteractionError` as is, anything else a code only (never a message). */
export function gateRefusal(error: unknown): InteractionError {
  if (error instanceof InteractionError) return error;
  if (error instanceof GateTimeout) return new InteractionError('ANSWER_REFUSED', { reason: GATE_TIMEOUT_REASON });
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return new InteractionError('ANSWER_REFUSED', { reason: typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : 'ERROR' });
}

/** A gate's bound, 1 s to 120 s (default 30 s); throws at registration for anything else. */
function gateTimeoutOf(gate: InteractionAnswerGate): number {
  const ms = gate.timeoutMs ?? GATE_TIMEOUT_DEFAULT_MS;
  if (!Number.isInteger(ms) || ms < 1 || ms > GATE_TIMEOUT_MAX_MS) throw new Error(`[interaction] an answer gate's timeoutMs must be an integer from 1 to ${GATE_TIMEOUT_MAX_MS}`);
  return ms;
}

/** An answer, whatever the channel (04 §8.2): who, through which channel, which action (by id or by button index). */
export interface AnswerInput {
  ticketId: string;
  userId: number;
  via: ChannelKind;
  actionId?: string;
  actionIndex?: number;
  stepUpProof?: string | null;
}

/**
 * The life of a question (04 §8): creation (`ask`), first answer wins (one conditional UPDATE `open → answered`), late
 * answers refused (`expires_at` checked in the same UPDATE), expiry sweep, cancellation, hand-over of each outcome to
 * the `onAnswer` handler of its kind (at least once, retried with a persisted schedule), closing of the other surfaces.
 */
@Injectable()
export class InteractionTicketService {
  private readonly logger = new Logger('InteractionTickets');
  private readonly handlers = new Map<string, { handler: InteractionAnswerHandler; source: string | null; gate: InteractionAnswerGate | null }>();

  constructor(
    @InjectRepository(InteractionTicketEntity) private readonly tickets: Repository<InteractionTicketEntity>,
    @InjectRepository(InteractionTicketRecipientEntity) private readonly recipients: Repository<InteractionTicketRecipientEntity>,
    private readonly delivery: InteractionDeliveryService,
    private readonly registry: InteractionProviderRegistry,
    private readonly cards: InteractionTicketCardStore,
    private readonly inbox: InteractionInboxService,
    private readonly renderer: InteractionRenderer,
    private readonly background: InteractionBackground,
    private readonly config: InteractionConfig,
    @Inject(INTERACTION_DIRECTORY) private readonly directory: InteractionDirectory,
    @Inject(INTERACTION_REALTIME) private readonly realtime: InteractionRealtimePort,
    @InjectRepository(InteractionUserChannelEntity) private readonly channels: Repository<InteractionUserChannelEntity>,
    @Inject(INTERACTION_AUDIT) private readonly audit: InteractionAuditSink,
    @Optional() @Inject(INTERACTION_STEP_UP) private readonly stepUp?: InteractionStepUpPort | null,
  ) {}

  /**
   * One handler per kind; returns its removal. `options.source` BINDS the kind to one source (review F3): an `ask` of
   * that kind from another source is refused (`INVALID_QUESTION { field: 'source' }`) and a stored ticket of another
   * source is never handed to the handler (its hand-over fails at once). Handlers must still check `answer.source` and
   * the stored `ticketId` (a kind without a bound source accepts every source).
   */
  onAnswer(kind: string, handler: InteractionAnswerHandler, options: InteractionAnswerOptions = {}): () => void {
    if (this.handlers.has(kind)) throw new Error(`[interaction] a handler is already registered for "${kind}"`);
    const source = options.source ?? null;
    if (source !== null && (typeof source !== 'string' || !SOURCE_PATTERN.test(source))) throw new Error(`[interaction] invalid source "${String(source)}" bound to "${kind}"`);
    const gate = options.gate ?? null;
    if (gate !== null) {
      if (typeof gate.apply !== 'function' || (gate.check !== undefined && typeof gate.check !== 'function')) throw new Error(`[interaction] the answer gate of "${kind}" needs apply() (and check() when given)`);
      gateTimeoutOf(gate);
    }
    const entry = { handler, source, gate };
    this.handlers.set(kind, entry);
    return () => {
      if (this.handlers.get(kind) === entry) this.handlers.delete(kind);
    };
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  /** 04 §8.1: returns once the in-app notices are written; the external channels follow in the background. */
  async ask(recipientIds: number | number[], question: InteractionQuestion): Promise<InteractionTicket> {
    const now = new Date();
    const ids = normalizeRecipients(recipientIds, MAX_RECIPIENTS);
    const q = validateQuestion(question, { now, maxTtlSeconds: this.config.number('interaction_askMaxTtlSeconds', 60, 604800) });
    if (q.freshProof && !this.stepUp) throw new InteractionError('STEP_UP_UNAVAILABLE');
    const binding = this.handlers.get(q.kind);
    if (!binding) throw new InteractionError('UNKNOWN_QUESTION_KIND', { kind: q.kind });
    if (binding.source !== null && binding.source !== q.source) throw new InteractionError('INVALID_QUESTION', { field: 'source' });
    const existing = await this.tickets.findOne({ where: { source: q.source, correlationId: q.correlationId } });
    if (existing) return this.toTicket(existing, []);
    const active: number[] = [];
    for (const id of ids) if (await this.directory.isActive(id)) active.push(id);
    if (active.length === 0) throw new InteractionError('INTERACTION_NO_HUMAN');
    const row = await this.insertTicket(q);
    if (!row.created) return this.toTicket(row.ticket, []);
    const ticket = row.ticket;
    await this.recipients.insert(active.map((userId) => ({ ticketId: ticket.id, userId, notifiedAt: now, seenAt: null })));
    const reports: DeliveryReport[] = [];
    const pending: Array<{ userId: number; reserved: ReservedDelivery[] }> = [];
    for (const userId of active) {
      const meta: DeliveryMeta = { dedupKey: `t:${ticket.id}`, category: q.category, priority: 'normal', type: QUESTION_TYPE, ticketId: ticket.id };
      const inapp = await this.delivery.reserveInapp(userId, meta);
      const noticeId = inapp === 'duplicate' ? null : await this.inbox.write(userId, ticketNotice(q), ticket.id);
      this.realtime.publish(userId, { type: 'ticket.opened', id: ticket.id });
      const reserved = await this.delivery.planAndReserve(userId, meta, []);
      pending.push({ userId, reserved });
      reports.push({ userId, noticeId, outcome: 'inapp_only', deliveries: [{ kind: INAPP_KIND, status: inapp === 'duplicate' ? 'duplicate' : 'sent', code: null }, ...reserved.map((r) => ({ kind: r.kind, status: r.status, code: r.code }))] });
    }
    this.background.run('ticket.externals', async () => {
      for (const { userId, reserved } of pending) await this.delivery.sendReserved(userId, reserved, this.builder(ticket, userId));
    });
    return { id: ticket.id, kind: ticket.kind, source: ticket.source, correlationId: ticket.correlationId, status: 'open', expiresAt: ticket.expiresAt, recipients: active, deliveries: reports };
  }

  private async insertTicket(q: CleanQuestion): Promise<{ ticket: InteractionTicketEntity; created: boolean }> {
    const answerableFrom = answerableKinds(q.answerableFrom, this.registry.answerChannels(), q.freshProof);
    try {
      const ticket = await this.tickets.save(
        this.tickets.create({
          source: q.source,
          kind: q.kind,
          correlationId: q.correlationId,
          category: q.category,
          summary: q.summary,
          actions: q.actions,
          answerableFrom,
          freshProof: q.freshProof,
          status: 'open',
          expiresAt: q.expiresAt,
          dispatchStatus: 'none',
          dispatchAttempts: 0,
          dispatchNextAt: null,
        }),
      );
      return { ticket, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const ticket = await this.tickets.findOne({ where: { source: q.source, correlationId: q.correlationId } });
      if (!ticket) throw error;
      return { ticket, created: false };
    }
  }

  /** The message of a ticket for one channel: the app's summary, its actions, whether this channel may answer. */
  private builder(ticket: InteractionTicketEntity, userId: number): MessageBuilder {
    return async (kind, deliveryId, provider) => {
      const lang = await this.renderer.localeOf(userId);
      const title = await this.renderer.render(ticket.summary.title, lang, TITLE_MAX);
      const parts = [ticket.summary.body ? await this.renderer.render(ticket.summary.body, lang, BODY_MAX) : ''];
      for (const field of ticket.summary.fields ?? []) parts.push(`${await this.renderer.render(field.label, lang, 80)}: ${field.value}`);
      const actions: RenderedAction[] = [];
      for (const [index, action] of ticket.actions.entries()) actions.push({ index, id: action.id, label: await this.renderer.render(action.label, lang, 40), style: action.style });
      const openUrl = this.renderer.absoluteUrl(ticket.summary.url ?? DEFAULT_OPEN_PATH);
      // A `freshProof` question never gets buttons on a channel that cannot bring the proof (04 §22), whatever the row says.
      const answerable = provider.capabilities.has('reply') && (ticket.answerableFrom ?? []).includes(kind) && (!ticket.freshProof || bringsFreshProof(provider.proof));
      return this.delivery.message(kind, {
        deliveryId,
        userId,
        locale: lang,
        category: ticket.category as 'approval' | 'security',
        type: QUESTION_TYPE,
        title,
        body: parts.filter((part) => part !== '').join('\n'),
        url: openUrl,
        question: { ticketId: ticket.id, actions, expiresAt: ticket.expiresAt, answerable, openUrl },
      });
    };
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  async getTicket(ticketId: string): Promise<InteractionTicket | null> {
    const row = /^[0-9a-f-]{36}$/i.test(ticketId) ? await this.tickets.findOne({ where: { id: ticketId } }) : null;
    return row ? this.toTicket(row, []) : null;
  }

  private async toTicket(row: InteractionTicketEntity, deliveries: DeliveryReport[]): Promise<InteractionTicket> {
    const recipients = (await this.recipients.find({ where: { ticketId: row.id } })).map((r) => r.userId);
    return { id: row.id, kind: row.kind, source: row.source, correlationId: row.correlationId, status: row.status as InteractionTicket['status'], expiresAt: row.expiresAt, recipients, deliveries };
  }

  /** A ticket for one of its recipients; anyone else (and an unknown id) gets the same `NOT_FOUND`. */
  async ticketFor(userId: number, ticketId: string): Promise<InteractionTicketDto> {
    const ticket = await this.recipientTicket(userId, ticketId);
    await this.recipients.update({ ticketId, userId, seenAt: IsNull() }, { seenAt: new Date() });
    return toTicketDto(ticket, userId);
  }

  private async recipientTicket(userId: number, ticketId: string): Promise<InteractionTicketEntity> {
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket || !(await this.recipients.exists({ where: { ticketId, userId } }))) throw new InteractionError('NOT_FOUND');
    return ticket;
  }

  // ---------------------------------------------------------------------------
  // Answer (human review required)
  // ---------------------------------------------------------------------------

  /**
   * 04 §8.2: recipient (else `NOT_FOUND`), recipient still active (else `NOT_FOUND`, review F9), channel in
   * `answerableFrom` (else `CHANNEL_NOT_ALLOWED`), a channel other than `inapp` offered, configured, on and not disabled by
   * an administrator (`assertChannelOn`, review F2), known action (else `INVALID_INPUT`), a step-up proof for a
   * `freshProof` question (`answerWithProof`: consumed by the winner only, bound to this ticket), then ONE conditional
   * UPDATE `open → answered` that checks `expires_at > <the instant of that UPDATE>` (review F4): a single winner, never
   * after the expiry; the others get `ALREADY_ANSWERED`, `EXPIRED` or `CANCELLED` and change nothing. Every answer and
   * every refusal is written to the audit sink (ids and codes only).
   */
  async answer(input: AnswerInput): Promise<InteractionTicketEntity> {
    try {
      const answered = await this.decide(input);
      await this.recordAnswer('ticket.answer', input, answered, null);
      return answered;
    } catch (error) {
      await this.recordAnswer('ticket.answer_refused', input, null, errorCode(error));
      throw error;
    }
  }

  private async decide(input: AnswerInput): Promise<InteractionTicketEntity> {
    const ticket = await this.recipientTicket(input.userId, input.ticketId);
    // An account deactivated since the question was asked answers nothing, whatever the channel (review F9).
    if (!(await this.directory.isActive(input.userId).catch(() => false))) throw new InteractionError('NOT_FOUND');
    const answerableFrom = ticket.answerableFrom ?? [INAPP_KIND];
    if (!answerableFrom.includes(input.via)) throw new InteractionError('CHANNEL_NOT_ALLOWED', { required: answerableFrom });
    if (input.via !== INAPP_KIND) await this.assertChannelOn(input.userId, input.via);
    const action = input.actionId !== undefined ? ticket.actions.find((candidate) => candidate.id === input.actionId) : ticket.actions[input.actionIndex ?? -1];
    if (!action) throw new InteractionError('INVALID_INPUT', { field: 'actionId' });
    // Non-authoritative early answer (the UPDATE decides): a closed ticket never reaches the step-up port.
    if (ticket.status !== 'open' || ticket.expiresAt.getTime() <= Date.now()) throw closedError(ticket, new Date());
    const fields: Partial<InteractionTicketEntity> = { answerAction: action.id, answeredVia: input.via, answeredBy: input.userId };
    // A channel other than `inapp` is checked AGAIN inside the deciding UPDATE (second review, finding 2): a switch
    // flipped during the claim wait or the step-up call (up to 2 × CLAIM_MS) still blocks the answer.
    const guard = input.via !== INAPP_KIND ? { userId: input.userId, kind: input.via } : null;
    const gate = this.gateOf(ticket);
    const won = gate
      ? await this.answerThroughGate(ticket, input, fields, gate)
      : ticket.freshProof
        ? await this.answerWithProof(ticket, input, fields, guard)
        : await this.decideNow(ticket.id, fields, guard);
    const fresh = (await this.tickets.findOne({ where: { id: ticket.id } })) as InteractionTicketEntity;
    if (!won) {
      if (guard && fresh.status === 'open' && fresh.expiresAt.getTime() > Date.now()) await this.assertChannelOn(guard.userId, guard.kind);
      throw closedError(fresh, new Date());
    }
    this.afterClose(fresh);
    return fresh;
  }

  /**
   * Review F2: a channel other than `inapp` answers only while the app offers its kind and the user's row of it exists,
   * is on and is not disabled by an administrator. The owner's and the administrator's switches stop its answers at once,
   * cards already sent included.
   */
  private async assertChannelOn(userId: number, kind: string): Promise<void> {
    if (!this.registry.enabledKinds().includes(kind)) throw new InteractionError('KIND_DISABLED');
    const row = await this.channels.findOne({ where: { userId, kind } });
    if (row?.adminDisabled) throw new InteractionError('ADMIN_DISABLED');
    if (!row || !row.enabled) throw new InteractionError('CHANNEL_NOT_ALLOWED', { reason: 'CHANNEL_OFF' });
  }

  /**
   * The conditional UPDATE `open → answered` judged at the instant it runs (review F4: no clock read before a slow step),
   * and, for a channel other than `inapp`, only while that channel's row is still on and not disabled by an administrator.
   */
  private decideNow(id: string, fields: Partial<InteractionTicketEntity>, guard: ChannelGuard | null, claim?: HeldClaim): Promise<boolean> {
    const at = new Date();
    return this.transition(id, 'answered', at, { ...fields, answeredAt: at }, claim, guard);
  }

  /** The gate of a ticket's kind, only when its handler is bound to the ticket's source (or to none). */
  private gateOf(ticket: InteractionTicketEntity): InteractionAnswerGate | null {
    const entry = this.handlers.get(ticket.kind);
    if (!entry?.gate || (entry.source !== null && entry.source !== ticket.source)) return null;
    return entry.gate;
  }

  /**
   * An answer through the kind's gate (C2, `InteractionAnswerGate`; human review required): `check` (no effect) → claim
   * (`applying`) → the step-up proof consumed by the claimant → `apply` (the effect) → `open → answered` bound to the claim.
   * A refusal before `apply` leaves the ticket untouched and the proof unspent; a refusal OF `apply` releases the claim
   * (the ticket is open again); a timed-out `apply` keeps the claim until it lapses (the effect may still land).
   */
  private async answerThroughGate(ticket: InteractionTicketEntity, input: AnswerInput, fields: Partial<InteractionTicketEntity>, gate: InteractionAnswerGate): Promise<boolean> {
    const pending: PendingAnswer = { ticketId: ticket.id, kind: ticket.kind, source: ticket.source, correlationId: ticket.correlationId, actionId: String(fields.answerAction), via: input.via, answeredBy: input.userId, freshProof: ticket.freshProof === true };
    if (gate.check) await gateWithin(gate.check(pending), GATE_CHECK_TIMEOUT_MS).catch((error: unknown) => Promise.reject(gateRefusal(error)));
    const proof = ticket.freshProof ? await this.proofCarried(ticket, input) : null;
    const timeout = gateTimeoutOf(gate);
    const token = await this.claimForAnswer(ticket.id, APPLY_CLAIM, timeout + APPLY_CLAIM_MARGIN_MS, APPLY_WAIT_MS);
    if (token === 'busy') throw new InteractionError('IN_PROGRESS');
    if (token === null) return false;
    const claim: HeldClaim = { marker: APPLY_CLAIM, token };
    if (proof) await this.consumeUnderClaim(ticket.id, input, proof, claim);
    try {
      await gateWithin(gate.apply(pending), timeout);
    } catch (error) {
      // A timeout, or an error the app says may still have its effect: the claim stays until it lapses (no second answer meanwhile).
      if (!(error instanceof GateTimeout) && gate.isUncertain?.(error) !== true) await this.releaseClaim(ticket.id, claim);
      throw gateRefusal(error);
    }
    const at = new Date();
    const won = await this.transition(ticket.id, 'answered', at, { ...fields, answeredAt: at }, claim, null, true);
    if (!won) this.logger.error(`ticket ${ticket.id}: the answer was applied but its claim was lost (the app reconciles it)`);
    return won;
  }

  /** `freshProof`: the channel brings proofs and the answer carries one (else `CHANNEL_NOT_ALLOWED` / `STEP_UP_REQUIRED`, nothing spent). */
  private async proofCarried(ticket: InteractionTicketEntity, input: AnswerInput): Promise<{ stepUp: InteractionStepUpPort; purpose: string; proof: string }> {
    const purpose = stepUpPurposeOf(ticket.id);
    if (!bringsFreshProof(this.registry.proofOf(input.via))) throw new InteractionError('CHANNEL_NOT_ALLOWED', { required: (ticket.answerableFrom ?? [INAPP_KIND]).filter((kind) => bringsFreshProof(this.registry.proofOf(kind))) });
    const stepUp = this.stepUp;
    if (!stepUp) throw new InteractionError('STEP_UP_REQUIRED', { methods: [] });
    if (!input.stepUpProof) throw new InteractionError('STEP_UP_REQUIRED', { methods: await stepUp.methods(input.userId).catch(() => []), purpose });
    return { stepUp, purpose, proof: input.stepUpProof };
  }

  /** The claimant consumes its proof (bounded); invalid: the claim goes, the ticket stays open, `STEP_UP_REQUIRED`. */
  private async consumeUnderClaim(ticketId: string, input: AnswerInput, carried: { stepUp: InteractionStepUpPort; purpose: string; proof: string }, claim: HeldClaim): Promise<void> {
    const ok = await withTimeout(carried.stepUp.consume(carried.proof, carried.purpose, input.userId), CONSUME_TIMEOUT_MS).catch(() => false);
    if (ok === true) return;
    await this.releaseClaim(ticketId, claim);
    throw new InteractionError('STEP_UP_REQUIRED', { methods: await carried.stepUp.methods(input.userId).catch(() => []), purpose: carried.purpose });
  }

  /**
   * The open tickets of a source (C2), or its one ticket of `correlationId`: an app reconciles them with its own state (a
   * question it no longer asks is cancelled). `applying`: an answer is being applied now (leave it). Oldest first, 500 at most.
   */
  async openTickets(source: string, options: { correlationId?: string; limit?: number } = {}): Promise<OpenTicketRef[]> {
    if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) return [];
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? OPEN_TICKETS_MAX)), OPEN_TICKETS_MAX);
    const where = { source, status: 'open', ...(typeof options.correlationId === 'string' ? { correlationId: options.correlationId } : {}) };
    const rows = await this.tickets.find({ where, order: { createdAt: 'ASC' }, take: limit });
    const recipients = rows.length > 0 ? await this.recipients.find({ where: { ticketId: In(rows.map((row) => row.id)) } }) : [];
    const now = Date.now();
    return rows.map((row) => ({
      ticketId: row.id,
      correlationId: row.correlationId,
      applying: row.dispatchStatus === APPLY_CLAIM && (row.dispatchNextAt?.getTime() ?? 0) > now,
      recipients: recipients.filter((recipient) => recipient.ticketId === row.id).map((recipient) => recipient.userId),
      freshProof: row.freshProof === true,
    }));
  }

  /**
   * One recipient may no longer see a question (C2: the app judges they lost the access): their recipient row, their notices of it and their
   * open cards go (a card of the app's own channel is redrawn by the app), `ticket.closed` reaches them; with nobody left, the ticket is
   * cancelled. From then on the ticket is unknown to them (`NOT_FOUND`, like any other). False when they were no recipient of an open ticket.
   */
  /** `UserInteractionService.requireFreshProof`: a conditional UPDATE bound to the row as read (open, not yet `freshProof`, no live apply claim). */
  async requireFreshProof(source: string, correlationId: string): Promise<boolean> {
    if (typeof source !== 'string' || !SOURCE_PATTERN.test(source) || typeof correlationId !== 'string') return false;
    const ticket = await this.tickets.findOne({ where: { source, correlationId, status: 'open' } });
    if (!ticket || ticket.freshProof) return false;
    if (ticket.dispatchStatus === APPLY_CLAIM && (ticket.dispatchNextAt?.getTime() ?? 0) > Date.now()) return false;
    const result = await this.tickets.update(
      { id: ticket.id, status: 'open', freshProof: false, dispatchStatus: ticket.dispatchStatus, dispatchNextAt: ticket.dispatchNextAt ?? IsNull() },
      { freshProof: true },
    );
    return (result.affected ?? 0) > 0;
  }

  async revokeRecipient(source: string, correlationId: string, userId: number, reason: string): Promise<boolean> {
    const ticket = await this.tickets.findOne({ where: { source, correlationId } });
    if (!ticket || ticket.status !== 'open') return false;
    const removed = await this.recipients.delete({ ticketId: ticket.id, userId });
    if ((removed.affected ?? 0) === 0) return false;
    await this.inbox.forgetTicketFor(userId, ticket.id);
    await this.cards.closeFor(ticket.id, userId);
    this.realtime.publish(userId, { type: 'ticket.closed', id: ticket.id, data: { status: 'cancelled' } });
    if ((await this.recipients.count({ where: { ticketId: ticket.id } })) === 0) await this.cancelById(ticket.id, reason);
    return true;
  }

  /** The audit line of an answer or of a refused one (review F9): ids and codes, never the question's text. */
  private async recordAnswer(action: string, input: AnswerInput, ticket: InteractionTicketEntity | null, code: string | null): Promise<void> {
    const ticketId = typeof input.ticketId === 'string' && /^[0-9a-f-]{36}$/i.test(input.ticketId) ? input.ticketId : null;
    await this.audit
      .record({
        action,
        actor: { userId: input.userId, admin: false },
        ownerUserId: input.userId,
        kind: String(input.via).slice(0, 16),
        at: new Date(),
        ticket: { id: ticketId, kind: ticket?.kind ?? null, source: ticket?.source ?? null, actionId: ticket?.answerAction ?? null },
        code,
      })
      .catch(() => undefined);
  }

  /**
   * A `freshProof` answer (04 §21.1, §22; human review required). The proof is consumed by the WINNER only: never for a
   * ticket that another answer, the sweep or a cancellation closed first, never by the loser of a race.
   * 1. The channel must bring a proof (declared `proof: 'in_app'`) and the answer must carry one.
   * 2. The ticket is CLAIMED by a conditional UPDATE (`status` stays `open`, `dispatch_status = 'claimed'` until
   *    `now + CLAIM_MS`, that instant being the claim's token). A concurrent answer does not touch its own proof: it
   *    waits until the claim ends (answered → `ALREADY_ANSWERED`; released → it claims in turn).
   * 3. The claimant consumes its proof through the port (bounded by `CONSUME_TIMEOUT_MS < CLAIM_MS`).
   * 4. Valid: the same conditional UPDATE `open → answered`, bound to this claim. Invalid: the claim is released, the
   *    ticket stays open, `STEP_UP_REQUIRED`.
   * A claimant that dies between 2 and 4 leaves an OPEN ticket whose claim lapses after `CLAIM_MS` (the next answer
   * takes it over; nothing is handed over): never an answer without a consumed proof. A transaction around the port
   * call was rejected: SQLite shares one connection between concurrent requests, and on Postgres a row lock held
   * across the port call can starve the pool the port itself needs.
   */
  private async answerWithProof(ticket: InteractionTicketEntity, input: AnswerInput, fields: Partial<InteractionTicketEntity>, guard: ChannelGuard | null): Promise<boolean> {
    const carried = await this.proofCarried(ticket, input);
    const token = await this.claimForAnswer(ticket.id, PROOF_CLAIM, CLAIM_MS, 2 * CLAIM_MS);
    if (token === null || token === 'busy') return false;
    const claim: HeldClaim = { marker: PROOF_CLAIM, token };
    await this.consumeUnderClaim(ticket.id, input, carried, claim);
    // Judged now, after the port answered: a check that outlasted `expires_at` is EXPIRED (review F4); a channel switched
    // off meanwhile refuses it (second review, finding 2), and the claim is released at once.
    const won = await this.decideNow(ticket.id, fields, guard, claim);
    if (!won) await this.releaseClaim(ticket.id, claim);
    return won;
  }

  /**
   * Claims an open ticket not past `expires_at` (judged at each attempt: a wait that outlasts the expiry ends there):
   * `dispatch_status = marker` until `now + durationMs`, that instant being the claim's token. A lapsed claim of either kind
   * (`claimed`, `applying`) is taken over; while another answer holds a live one, waits up to `waitMs`, then `busy`. `null`
   * once the ticket is closed or expired.
   */
  private async claimForAnswer(ticketId: string, marker: string, durationMs: number, waitMs: number): Promise<Date | 'busy' | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const at = new Date();
      const until = new Date(at.getTime() + durationMs);
      const result = await this.tickets
        .createQueryBuilder()
        .update(InteractionTicketEntity)
        .set({ dispatchStatus: marker, dispatchNextAt: until })
        .where('id = :id', { id: ticketId })
        .andWhere('status = :open', { open: 'open' })
        .andWhere('expires_at > :at', { at })
        .andWhere(
          new Brackets((free) =>
            free.where('dispatch_status = :none', { none: 'none' }).orWhere(new Brackets((lapsed) => lapsed.where('dispatch_status IN (:...claims)', { claims: [PROOF_CLAIM, APPLY_CLAIM] }).andWhere('dispatch_next_at <= :at', { at }))),
          ),
        )
        .execute();
      if ((result.affected ?? 0) > 0) return until;
      const row = await this.tickets.findOne({ where: { id: ticketId } });
      if (!row || row.status !== 'open' || row.expiresAt.getTime() <= Date.now()) return null;
      if (row.dispatchStatus !== 'none' && row.dispatchStatus !== PROOF_CLAIM && row.dispatchStatus !== APPLY_CLAIM) return null;
      if (Date.now() >= deadline) return 'busy';
      await delay(CLAIM_POLL_MS);
    }
  }

  /** A refused answer: the claim goes, the ticket stays open (only this claim: a lapsed one taken over is not touched). */
  private async releaseClaim(ticketId: string, claim: HeldClaim): Promise<void> {
    await this.tickets
      .createQueryBuilder()
      .update(InteractionTicketEntity)
      .set({ dispatchStatus: 'none', dispatchNextAt: null })
      .where('id = :id', { id: ticketId })
      .andWhere('status = :open', { open: 'open' })
      .andWhere('dispatch_status = :marker', { marker: claim.marker })
      .andWhere('dispatch_next_at = :claim', { claim: claim.token })
      .execute();
  }

  /**
   * The only way out of `open`. `answered` requires `expires_at > now` (and, for a `freshProof` answer, still holding its
   * claim; a gated answer: holding its claim, judged without `expires_at`, `effectApplied`), `expired` requires
   * `expires_at <= now`; the hand-over is scheduled in the same statement (`dispatch_status = 'pending'`, leased to this
   * process). The sweep and a cancellation close a proof-claimed ticket too, never one whose gate is applying an answer
   * now (a live `applying` claim: they take it once it lapses).
   */
  private async transition(id: string, status: 'answered' | 'expired' | 'cancelled', now: Date, fields: Partial<InteractionTicketEntity>, claim?: HeldClaim, guard?: ChannelGuard | null, effectApplied = false): Promise<boolean> {
    const query = this.tickets
      .createQueryBuilder()
      .update(InteractionTicketEntity)
      .set({ ...fields, status, dispatchStatus: 'pending', dispatchNextAt: new Date(now.getTime() + DISPATCH_LEASE_MS) })
      .where('id = :id', { id })
      .andWhere('status = :open', { open: 'open' });
    if (status === 'answered' && !effectApplied) query.andWhere('expires_at > :now', { now });
    if (status === 'expired') query.andWhere('expires_at <= :now', { now });
    // Never over a gate applying an answer now, except by that very claim (it lapses: then anyone takes the ticket).
    if (claim?.marker !== APPLY_CLAIM) query.andWhere(new Brackets((idle) => idle.where('dispatch_status <> :applying', { applying: APPLY_CLAIM }).orWhere('dispatch_next_at <= :now', { now })));
    if (claim) query.andWhere('dispatch_status = :claimed', { claimed: claim.marker }).andWhere('dispatch_next_at = :claim', { claim: claim.token });
    if (guard) {
      // Same statement: the answer is written only if the channel is on at that instant (a portable EXISTS subquery).
      const channelOn = this.channels.createQueryBuilder('guard').select('1').where('guard.userId = :guardUser').andWhere('guard.kind = :guardKind').andWhere('guard.enabled = :guardOn').andWhere('guard.adminDisabled = :guardOff').getQuery();
      query.andWhere(`EXISTS (${channelOn})`).setParameters({ guardUser: guard.userId, guardKind: guard.kind, guardOn: true, guardOff: false });
    }
    const result = await query.execute();
    return (result.affected ?? 0) > 0;
  }

  /** Hand-over and closing of the other surfaces, in the background (the answer returns at once). */
  private afterClose(ticket: InteractionTicketEntity): void {
    this.background.run('ticket.close', async () => {
      await this.closeSurfaces(ticket);
      await this.dispatch(ticket.id, true);
    });
  }

  // ---------------------------------------------------------------------------
  // Expiry, cancellation, hand-over
  // ---------------------------------------------------------------------------

  /** `cancel(source, correlationId)`: false when the ticket is unknown or already closed. */
  async cancel(source: string, correlationId: string, reason: string): Promise<boolean> {
    const ticket = await this.tickets.findOne({ where: { source, correlationId } });
    return ticket ? this.cancelById(ticket.id, reason) : false;
  }

  async cancelById(ticketId: string, reason: string): Promise<boolean> {
    const now = new Date();
    if (!(await this.transition(ticketId, 'cancelled', now, { cancelReason: reason.slice(0, 64) }))) return false;
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (ticket) this.afterClose(ticket);
    return true;
  }

  /** One sweep (worker, under `runExclusive('interaction.expire')`): open tickets past `expires_at` → `expired`. */
  async expireDue(now = new Date()): Promise<number> {
    const due = await this.tickets.find({ where: { status: 'open', expiresAt: LessThanOrEqual(now) }, order: { expiresAt: 'ASC' }, take: SWEEP_BATCH });
    let expired = 0;
    for (const row of due) {
      if (!(await this.transition(row.id, 'expired', now, {}))) continue;
      expired += 1;
      const ticket = await this.tickets.findOne({ where: { id: row.id } });
      if (ticket) this.afterClose(ticket);
    }
    return expired;
  }

  /** Outcomes whose hand-over failed (or whose process died): taken over once their wait has passed. */
  async retryDispatches(now = new Date()): Promise<number> {
    const due = await this.tickets.find({ where: { dispatchStatus: 'pending', dispatchNextAt: LessThanOrEqual(now) }, take: 50 });
    for (const row of due) await this.dispatch(row.id, false, now);
    return due.length;
  }

  /**
   * Hands the outcome to the handler of its kind. `owned`: the caller just closed the ticket (its lease); otherwise the
   * ticket is claimed first (conditional UPDATE). Success → `done`; failure → retried later, the 5th one is final and
   * the administrators get a `security` notice.
   */
  async dispatch(ticketId: string, owned: boolean, now = new Date()): Promise<void> {
    if (!owned && !(await this.claim(ticketId, now))) return;
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    if (!ticket || ticket.dispatchStatus !== 'pending') return;
    const binding = this.handlers.get(ticket.kind);
    if (binding && binding.source !== null && binding.source !== ticket.source) {
      // A ticket of another source than the one its kind is bound to never reaches the handler (review F3).
      await this.tickets.update({ id: ticketId, dispatchStatus: 'pending' }, { dispatchStatus: 'failed', dispatchNextAt: null });
      this.logger.warn(`hand-over of ticket ${ticket.id} (${ticket.kind}) refused: source not bound to this kind`);
      return;
    }
    try {
      if (!binding) throw new InteractionError('UNKNOWN_QUESTION_KIND');
      await binding.handler(answerOf(ticket));
      await this.tickets.update({ id: ticketId, dispatchStatus: 'pending' }, { dispatchStatus: 'done', dispatchNextAt: null });
    } catch (error) {
      await this.dispatchFailed(ticket, errorCode(error));
    }
  }

  private async claim(ticketId: string, now: Date): Promise<boolean> {
    const result = await this.tickets
      .createQueryBuilder()
      .update(InteractionTicketEntity)
      .set({ dispatchNextAt: new Date(now.getTime() + DISPATCH_LEASE_MS) })
      .where('id = :id', { id: ticketId })
      .andWhere('dispatch_status = :pending', { pending: 'pending' })
      .andWhere('dispatch_next_at <= :now', { now })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  private async dispatchFailed(ticket: InteractionTicketEntity, code: string): Promise<void> {
    const attempts = ticket.dispatchAttempts + 1;
    this.logger.warn(`hand-over of ticket ${ticket.id} (${ticket.kind}) failed (${code}), attempt ${attempts}/${DISPATCH_MAX_ATTEMPTS}`);
    if (attempts < DISPATCH_MAX_ATTEMPTS) {
      await this.tickets.update({ id: ticket.id, dispatchStatus: 'pending' }, { dispatchAttempts: attempts, dispatchNextAt: new Date(Date.now() + DISPATCH_BACKOFF_MS[attempts - 1]) });
      return;
    }
    await this.tickets.update({ id: ticket.id, dispatchStatus: 'pending' }, { dispatchAttempts: attempts, dispatchStatus: 'failed', dispatchNextAt: null });
    for (const adminId of await this.directory.adminUserIds().catch(() => [])) {
      await this.delivery
        .notify(adminId, {
          type: 'interaction.dispatch_failed',
          source: 'interaction',
          category: 'security',
          title: { key: 'interaction.server.dispatchFailed.title' },
          body: { key: 'interaction.server.dispatchFailed.body', params: { kind: ticket.kind } },
          dedupKey: `dispatch_failed:${ticket.id}`,
        })
        .catch((error: unknown) => this.logger.warn(`dispatch_failed notice not sent (${errorCode(error)})`));
    }
  }

  /**
   * `ticket.closed` to every recipient, cards redrawn, and a trace in the inbox when the answer came from outside the app: a channel whose
   * interface is inside the authenticated app (`proof: 'in_app'`, e.g. an app's own messaging, 04 §22) is not « outside » (C2).
   */
  private async closeSurfaces(ticket: InteractionTicketEntity): Promise<void> {
    const recipients = (await this.recipients.find({ where: { ticketId: ticket.id } })).map((row) => row.userId);
    for (const userId of recipients) this.realtime.publish(userId, { type: 'ticket.closed', id: ticket.id, data: { status: ticket.status, ...(ticket.answeredVia ? { via: ticket.answeredVia } : {}) } });
    await this.inbox.closeTicketNotices(ticket.id);
    const answer = answerOf(ticket);
    for (const card of await this.cards.closeAllOf(ticket.id)) {
      const provider = this.registry.get(card.kind);
      if (!provider?.closeCard) continue;
      await provider.closeCard({ ticketId: ticket.id, cardKey: card.cardKey, kind: card.kind, binding: card.binding, lang: card.lang }, answer).catch((error: unknown) => this.logger.warn(`card not redrawn (${errorCode(error)})`));
    }
    if (ticket.status === 'answered' && ticket.answeredVia && this.registry.proofOf(ticket.answeredVia) !== 'in_app') {
      for (const userId of recipients) await this.inbox.write(userId, answeredElsewhere(ticket), null);
    }
  }

  // ---------------------------------------------------------------------------
  // Administrators, accounts, retention
  // ---------------------------------------------------------------------------

  async adminList(filter: { status?: string; source?: string }): Promise<InteractionTicketAdminDto[]> {
    const rows = await this.tickets.find({ where: { ...(filter.status ? { status: filter.status } : {}), ...(filter.source ? { source: filter.source } : {}) }, order: { createdAt: 'DESC' }, take: 200 });
    const counts = new Map<string, number>();
    if (rows.length > 0) for (const row of await this.recipients.find({ where: { ticketId: In(rows.map((r) => r.id)) } })) counts.set(row.ticketId, (counts.get(row.ticketId) ?? 0) + 1);
    return rows.map((row) => toTicketAdminDto(row, counts.get(row.id) ?? 0));
  }

  /** Account deletion: open tickets of which the user is the only recipient are cancelled; the user leaves the others. */
  async forgetUser(userId: number): Promise<void> {
    for (const row of await this.recipients.find({ where: { userId } })) {
      const others = await this.recipients.count({ where: { ticketId: row.ticketId, userId: Not(userId) } });
      if (others === 0) await this.cancelById(row.ticketId, 'user_deleted');
    }
    await this.recipients.delete({ userId });
    await this.cards.forgetUser(userId);
  }

  /** Closed tickets older than the retention go, with their recipients and cards. */
  async purge(before: Date): Promise<void> {
    const old = await this.tickets.find({ where: { status: Not('open'), updatedAt: LessThan(before) }, select: { id: true }, take: 1000 });
    const ids = old.map((row) => row.id);
    if (ids.length === 0) return;
    await this.cards.deleteForTickets(ids);
    await this.recipients.delete({ ticketId: In(ids) });
    await this.tickets.delete({ id: In(ids) });
  }
}

/** The outcome as the handler receives it. */
export function answerOf(ticket: InteractionTicketEntity): InteractionAnswer {
  return {
    ticketId: ticket.id,
    kind: ticket.kind,
    source: ticket.source,
    correlationId: ticket.correlationId,
    status: ticket.status as InteractionAnswer['status'],
    actionId: ticket.status === 'answered' ? ticket.answerAction : null,
    via: ticket.status === 'answered' ? ticket.answeredVia : null,
    answeredBy: ticket.status === 'answered' ? ticket.answeredBy : null,
    at: ticket.answeredAt ?? ticket.updatedAt ?? new Date(),
  };
}

/** Why a ticket cannot be answered any more. */
export function closedError(ticket: InteractionTicketEntity, now: Date): InteractionError {
  if (ticket.status === 'answered') return new InteractionError('ALREADY_ANSWERED', { via: ticket.answeredVia ?? '', at: ticket.answeredAt ? ticket.answeredAt.toISOString() : '' });
  if (ticket.status === 'cancelled') return new InteractionError('CANCELLED');
  if (ticket.status === 'expired' || ticket.expiresAt.getTime() <= now.getTime()) return new InteractionError('EXPIRED');
  return new InteractionError('ALREADY_ANSWERED', { via: '', at: '' });
}

function ticketNotice(q: CleanQuestion): CleanNotice {
  return { type: QUESTION_TYPE, source: q.source, category: q.category, priority: 'normal', title: q.summary.title, body: q.summary.body ?? null, url: q.summary.url ?? null, dedupKey: null, data: null };
}

/** 04 §8.2.6: a trace in the inbox of every recipient when the answer came from outside the app (compromised account). */
function answeredElsewhere(ticket: InteractionTicketEntity): CleanNotice {
  return {
    type: 'interaction.answered_elsewhere',
    source: 'interaction',
    category: 'security',
    priority: 'normal',
    title: { key: 'interaction.server.answeredElsewhere.title' },
    body: { key: 'interaction.server.answeredElsewhere.body', params: { via: ticket.answeredVia ?? '', action: ticket.answerAction ?? '' } },
    url: ticket.summary.url ?? null,
    dedupKey: null,
    data: { ticketId: ticket.id },
  };
}
