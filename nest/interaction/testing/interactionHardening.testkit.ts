/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Hardening suite of lot C1 (run on SQLite AND Postgres, like the conformance suite): the `proof` capability of the
// channels (04 §22), a step-up proof consumed by the winner only (04 §21.1), first writes and caps safe under parallel
// calls (web push subscriptions, channel configuration, the administrators' switch, link codes, preferences), an
// administrator's switch never undone by the owner's stale write, and no secret (bot token, webhook secret, link code,
// push endpoint) in any log, error, audit line or row whatever the Bot API or the push service does. The Postgres pool
// variants of the races are in `interactionConcurrency.testkit.ts`.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Injectable, type Type } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { InteractionDeliveryEntity } from '../entities/InteractionDeliveryEntity';
import { InteractionLinkCodeEntity } from '../entities/InteractionLinkCodeEntity';
import { InteractionSecretEntity } from '../entities/InteractionSecretEntity';
import { InteractionTelegramBotEntity } from '../entities/InteractionTelegramBotEntity';
import { InteractionTicketCardEntity } from '../entities/InteractionTicketCardEntity';
import { InteractionTicketEntity } from '../entities/InteractionTicketEntity';
import { InteractionUserChannelEntity } from '../entities/InteractionUserChannelEntity';
import { InteractionWebPushSubscriptionEntity } from '../entities/InteractionWebPushSubscriptionEntity';
import { isInteractionError } from '../errors/InteractionError';
import { INTERACTION_ENTITIES } from '../interactionEntities';
import { hashCode } from '../pure/codes';
import { BrowserChannelProvider } from '../providers/browser/BrowserChannelProvider';
import { WebPushSender, type WebPushLibrary } from '../providers/browser/WebPushSender';
import { TelegramBotFleet } from '../providers/telegram/TelegramBotFleet';
import { TelegramChannelProvider } from '../providers/telegram/TelegramChannelProvider';
import { TelegramLinkService } from '../providers/telegram/TelegramLinkService';
import { TelegramUpdateHandler } from '../providers/telegram/TelegramUpdateHandler';
import { InteractionChannelService } from '../services/InteractionChannelService';
import { InteractionKeyService } from '../services/InteractionKeyService';
import { InteractionPrefService } from '../services/InteractionPrefService';
import { InteractionTicketService, PROOF_CLAIM } from '../services/InteractionTicketService';
import { UserInteractionService } from '../services/UserInteractionService';
import type { InteractionAnswer, InteractionCapability, InteractionProof } from '../types/interactionTypes';
import { stepUpPurposeOf, type InteractionStepUpPort, type StepUpMethod } from '../types/ports';
import type { ChannelConfigureResult, ChannelOwner, InteractionChannelProvider, StoredChannel } from '../types/providerTypes';
import { isBlockedAddress, type AddressGuard } from '../utils/netGuard';
import { BOT_TOKEN, ENDPOINT, http, idle, owner, pressUpdate, question, startUpdate, ThrowingProvider, TG_ACCOUNT } from './interactionConformance.testkit';
import { createInteractionHarness, type Harness, type HarnessDatabase, type HarnessOptions } from './interactionHarness';

// ---------------------------------------------------------------------------
// Providers and ports of the suite
// ---------------------------------------------------------------------------

function emptyChannel(userId: number, kind: string): StoredChannel {
  return { id: '', userId, kind, enabled: true, adminDisabled: false, position: 0, config: {}, verification: null, secretId: null, externalKey: null, verifiedAt: null };
}

abstract class SuiteProvider implements InteractionChannelProvider {
  abstract readonly kind: string;
  abstract readonly capabilities: ReadonlySet<InteractionCapability>;
  abstract readonly proof: InteractionProof;
  readonly configSchema = { parse: (input: unknown) => input, secretFields: [] as readonly string[] };
  readonly requiresVerification = false;
  async configure(ownerOf: ChannelOwner, _input: unknown, current: StoredChannel | null): Promise<ChannelConfigureResult> {
    return { channel: { ...(current ?? emptyChannel(ownerOf.userId, this.kind)), config: { on: true }, verifiedAt: new Date() }, secretOnce: null };
  }
  async verify(_owner: ChannelOwner, channel: StoredChannel): Promise<StoredChannel> {
    return channel;
  }
  async isReady(): Promise<boolean> {
    return true;
  }
  async send(): Promise<{ ok: boolean; code: string | null }> {
    return { ok: true, code: null };
  }
  async ownerView(): Promise<Record<string, unknown>> {
    return {};
  }
  async adminView(): Promise<Record<string, string | number | boolean | null>> {
    return {};
  }
}

/** An app's own reply channel INSIDE the authenticated app (AgentHub's messaging, 04 §22): `proof: 'in_app'`. */
@Injectable()
export class InAppReplyProvider extends SuiteProvider {
  readonly kind = 'hubchat';
  readonly capabilities: ReadonlySet<InteractionCapability> = new Set<InteractionCapability>(['notify', 'reply']);
  readonly proof: InteractionProof = 'in_app';
}

/** A provider whose `configure` waits for the test (an administrator acts meanwhile), storing a secret like Telegram. */
@Injectable()
export class GatedConfigureProvider extends SuiteProvider {
  readonly kind = 'gated';
  readonly capabilities: ReadonlySet<InteractionCapability> = new Set<InteractionCapability>(['notify']);
  readonly proof: InteractionProof = 'link';
  gate: Promise<void> = Promise.resolve();
  entered: () => void = () => undefined;
  override async configure(ownerOf: ChannelOwner, input: unknown, current: StoredChannel | null): Promise<ChannelConfigureResult> {
    this.entered();
    await this.gate;
    return super.configure(ownerOf, input, current);
  }
}

/**
 * A step-up port whose proofs are `ok:<purpose>:<label>`, each accepted ONCE; `consume` can be held until `n` calls
 * arrived (or a delay passed) so two answers are both inside it under the old ordering, and can run a hook meanwhile.
 */
@Injectable()
export class GatedStepUp implements InteractionStepUpPort {
  readonly calls: string[] = [];
  readonly consumed: string[] = [];
  hold: { calls: number; until: number } | null = null;
  during: (() => Promise<void>) | null = null;
  /** A slow port (network, database): `consume` answers after this many ms. */
  delayMs = 0;
  async methods(): Promise<StepUpMethod[]> {
    return ['totp'];
  }
  async begin(): Promise<Record<string, unknown>> {
    return {};
  }
  async complete(): Promise<{ proofId: string }> {
    return { proofId: 'x' };
  }
  async consume(proofId: string, purpose: string): Promise<boolean> {
    this.calls.push(proofId);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.hold) await this.waitHold(this.hold);
    if (this.during) await this.during();
    if (!proofId.startsWith(`ok:${purpose}:`) || this.consumed.includes(proofId)) return false;
    this.consumed.push(proofId);
    return true;
  }
  private waitHold(hold: { calls: number; until: number }): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.calls.length >= hold.calls || Date.now() >= hold.until) return resolve();
        setTimeout(check, 5);
      };
      check();
    });
  }
}

const PUSH_GUARD: AddressGuard = { allowPrivate: false, isBlocked: isBlockedAddress, resolve: async () => [{ address: '93.184.216.34', family: 4 }] };

/** The real sender with a `web-push` that fails like a push service would, quoting the endpoint everywhere it can. */
class FailingPushSender extends WebPushSender {
  protected override guard(): AddressGuard {
    return PUSH_GUARD;
  }
  protected override library(): Promise<WebPushLibrary | null> {
    return Promise.resolve({
      sendNotification: () => Promise.reject(Object.assign(new Error(`Received unexpected response code ${ENDPOINT}`), { name: 'WebPushError', statusCode: 500, body: `oops ${ENDPOINT}`, endpoint: ENDPOINT })),
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface HardeningOptions {
  database: () => HarnessDatabase;
}

const ENABLED = ['browser', 'telegram', 'boom', 'hubchat', 'gated'];
const PROVIDERS: Type<InteractionChannelProvider>[] = [ThrowingProvider, InAppReplyProvider, GatedConfigureProvider];
const codeOf = (error: unknown): string => (isInteractionError(error) ? error.code : `raw:${(error as Error)?.message ?? String(error)}`);
const proofFor = (ticketId: string, label: string): string => `ok:${stepUpPurposeOf(ticketId)}:${label}`;
const push = { keys: { p256dh: 'BPk' + 'a'.repeat(80), auth: 'auth' + 'b'.repeat(18) }, userAgent: 'Test/1.0' };

export function describeInteractionHardening(label: string, options: HardeningOptions): void {
  describe(`interaction hardening (04 §21, §22, §17 races, §13 secrets) — ${label}`, () => {
    let h: Harness;
    let handled: InteractionAnswer[];

    async function harness(extra: Partial<HarnessOptions> = {}, config: Record<string, unknown> = {}): Promise<Harness> {
      const created = await createInteractionHarness({ database: options.database(), config: { interaction_enabledKinds: ENABLED, interaction_providerTimeoutMs: 1000, ...config }, providers: PROVIDERS, stepUp: GatedStepUp, ...extra });
      for (const id of [1, 2, 3]) created.directory.add(id);
      created.directory.add(9, { admin: true });
      created.get(UserInteractionService).onAnswer('test.approval', async (answer) => {
        handled.push(answer);
      });
      return created;
    }

    beforeEach(async () => {
      handled = [];
      h = await harness();
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await idle(h).catch(() => undefined);
      await h.close();
    });

    const tickets = () => h.get(InteractionTicketService);
    const stepUp = () => h.get(GatedStepUp);
    const rowOf = (id: string) => h.dataSource.getRepository(InteractionTicketEntity).findOneByOrFail({ id });
    const answer = (ticketId: string, extra: { via?: string; actionId?: string; proof?: string | null } = {}) =>
      tickets()
        .answer({ ticketId, userId: 1, via: extra.via ?? 'inapp', actionId: extra.actionId ?? 'approve', stepUpProof: extra.proof ?? null })
        .then(() => 'won', codeOf);

    // -------------------------------------------------------------------------
    // 1. The `proof` capability (04 §22)
    // -------------------------------------------------------------------------

    it('proof-1. every channel of the list carries its declared proof (inapp in_app, browser / telegram link, the app’s in-app channel in_app)', async () => {
      const res = await http(h).get('/api/v1/interaction/me/channels').set('Authorization', 'Bearer user-1');
      expect(res.status).toBe(200);
      const proofs = Object.fromEntries((res.body as Array<{ kind: string; proof: string }>).map((channel) => [channel.kind, channel.proof]));
      expect(proofs).toEqual({ inapp: 'in_app', browser: 'link', telegram: 'link', boom: 'link', hubchat: 'in_app', gated: 'link' });
    });

    it('proof-2. a freshProof question is answerable from in_app channels only, with a valid proof; a link channel only leads into the app', async () => {
      h.telegram.addBot(BOT_TOKEN, BOT_TOKEN.split(':')[0], 'bot_of_1');
      await h.get(InteractionChannelService).configure(owner(1), 'telegram', { mode: 'own', token: BOT_TOKEN });
      const { code } = await h.get(TelegramChannelProvider).linkCode(owner(1));
      await h.get(TelegramUpdateHandler).handle('u1', BOT_TOKEN, startUpdate(1, TG_ACCOUNT, code));
      // The app's in-app channel answers only once its owner has it on (review F2).
      await h.get(InteractionChannelService).configure(owner(1), 'hubchat', {});
      const ticket = await h.get(UserInteractionService).ask(1, question({ freshProof: true, answerableFrom: ['inapp', 'hubchat', 'telegram'] }));
      await idle(h);
      expect((await rowOf(ticket.id)).answerableFrom).toEqual(['inapp', 'hubchat']);
      // Telegram (link): a message with an « open in the app » link, never a button.
      expect(h.telegram.sent().some((call) => (call.keyboard?.inline_keyboard ?? []).flat().some((button) => 'callback_data' in button))).toBe(false);
      expect(await h.dataSource.getRepository(InteractionTicketCardEntity).count({ where: { ticketId: ticket.id } })).toBe(0);
      expect(await answer(ticket.id, { via: 'telegram', proof: proofFor(ticket.id, 'tg') })).toBe('CHANNEL_NOT_ALLOWED');
      // Even a row that lists a link channel (tampered, or written before §22) never lets it bring the « proof ».
      await h.dataSource.getRepository(InteractionTicketEntity).update({ id: ticket.id }, { answerableFrom: ['inapp', 'hubchat', 'telegram'] });
      await expect(tickets().answer({ ticketId: ticket.id, userId: 1, via: 'telegram', actionId: 'approve', stepUpProof: proofFor(ticket.id, 'tg2') })).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED', details: { required: ['inapp', 'hubchat'] } });
      await expect(tickets().answer({ ticketId: ticket.id, userId: 1, via: 'hubchat', actionId: 'approve' })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', details: { methods: ['totp'], purpose: stepUpPurposeOf(ticket.id) } });
      expect(stepUp().calls).toEqual([]);
      expect(await answer(ticket.id, { via: 'hubchat', proof: proofFor(ticket.id, 'hub') })).toBe('won');
      await idle(h);
      expect(stepUp().consumed).toEqual([proofFor(ticket.id, 'hub')]);
      expect(handled).toEqual([expect.objectContaining({ ticketId: ticket.id, status: 'answered', via: 'hubchat', actionId: 'approve' })]);
    });

    it('proof-3. a question WITHOUT freshProof keeps every reply channel, link ones included (behaviour unchanged)', async () => {
      const ticket = await h.get(UserInteractionService).ask(1, question({ answerableFrom: ['inapp', 'hubchat', 'telegram'] }));
      expect((await rowOf(ticket.id)).answerableFrom).toEqual(['inapp', 'hubchat', 'telegram']);
      expect((await rowOf((await h.get(UserInteractionService).ask(1, question())).id)).answerableFrom).toEqual(['inapp', 'telegram', 'hubchat']);
    });

    // -------------------------------------------------------------------------
    // 2. A step-up proof is consumed by the winner only (04 §21.1)
    // -------------------------------------------------------------------------

    it('claim-1. two answers racing, each with its own valid proof: one winner, ONLY its proof consumed, the loser’s proof untouched', async () => {
      const ticket = await h.get(UserInteractionService).ask(1, question({ freshProof: true }));
      stepUp().hold = { calls: 2, until: Date.now() + 400 };
      const [a, b] = await Promise.all([answer(ticket.id, { proof: proofFor(ticket.id, 'a') }), answer(ticket.id, { actionId: 'deny', proof: proofFor(ticket.id, 'b') })]);
      expect([a, b].sort()).toEqual(['ALREADY_ANSWERED', 'won']);
      const winner = a === 'won' ? 'a' : 'b';
      expect(stepUp().consumed).toEqual([proofFor(ticket.id, winner)]);
      // The loser never reached the port: its proof is still usable (it would be, had the ticket been released).
      expect(stepUp().calls).toEqual([proofFor(ticket.id, winner)]);
      await idle(h);
      const row = await rowOf(ticket.id);
      expect([row.status, row.answerAction, row.dispatchStatus]).toEqual(['answered', winner === 'a' ? 'approve' : 'deny', 'done']);
      expect(handled.filter((entry) => entry.ticketId === ticket.id)).toHaveLength(1);
    });

    it('claim-2. an invalid proof releases the claim: the ticket stays open (never « answered » meanwhile), a valid proof answers it next', async () => {
      const ticket = await h.get(UserInteractionService).ask(1, question({ freshProof: true }));
      expect(await answer(ticket.id, { proof: 'forged-proof' })).toBe('STEP_UP_REQUIRED');
      expect(await answer(ticket.id, { proof: `ok:${stepUpPurposeOf('00000000-0000-4000-8000-000000000000')}:other-ticket` })).toBe('STEP_UP_REQUIRED');
      const open = await rowOf(ticket.id);
      expect([open.status, open.dispatchStatus, open.dispatchNextAt, open.answeredBy]).toEqual(['open', 'none', null, null]);
      expect(await answer(ticket.id, { proof: proofFor(ticket.id, 'good') })).toBe('won');
      expect(await answer(ticket.id, { proof: proofFor(ticket.id, 'late') })).toBe('ALREADY_ANSWERED');
      expect(stepUp().calls).toEqual(['forged-proof', expect.stringContaining('other-ticket'), proofFor(ticket.id, 'good')]);
    });

    it('claim-3. a dead claimant (stale claim) is taken over; a live claim makes a concurrent answer wait; a claim is never handed over', async () => {
      const ticket = await h.get(UserInteractionService).ask(1, question({ freshProof: true }));
      const repo = h.dataSource.getRepository(InteractionTicketEntity);
      // A claimant died mid-way: the ticket is OPEN, nothing is handed over, the claim lapses.
      await repo.update({ id: ticket.id }, { dispatchStatus: PROOF_CLAIM, dispatchNextAt: new Date(Date.now() + 300) });
      expect(await tickets().retryDispatches(new Date(Date.now() + 3_600_000))).toBe(0);
      expect((await h.get(UserInteractionService).getTicket(ticket.id))?.status).toBe('open');
      const started = Date.now();
      expect(await answer(ticket.id, { proof: proofFor(ticket.id, 'after-ghost') })).toBe('won');
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      await idle(h);
      expect(handled.filter((entry) => entry.ticketId === ticket.id)).toEqual([expect.objectContaining({ status: 'answered' })]);
      // An already lapsed claim is taken over at once.
      const other = await h.get(UserInteractionService).ask(1, question({ freshProof: true }));
      await repo.update({ id: other.id }, { dispatchStatus: PROOF_CLAIM, dispatchNextAt: new Date(Date.now() - 1000) });
      expect(await answer(other.id, { proof: proofFor(other.id, 'x') })).toBe('won');
    });

    it('claim-4. closed while the proof is checked (cancelled): the answer loses, the outcome is « cancelled » once; a closed ticket never reaches the port', async () => {
      const ticket = await h.get(UserInteractionService).ask(1, question({ freshProof: true }));
      stepUp().during = async () => {
        stepUp().during = null;
        expect(await tickets().cancelById(ticket.id, 'race')).toBe(true);
      };
      expect(await answer(ticket.id, { proof: proofFor(ticket.id, 'a') })).toBe('CANCELLED');
      await idle(h);
      expect(handled.filter((entry) => entry.ticketId === ticket.id)).toEqual([expect.objectContaining({ status: 'cancelled', actionId: null })]);
      const calls = stepUp().calls.length;
      expect(await answer(ticket.id, { proof: proofFor(ticket.id, 'b') })).toBe('CANCELLED');
      expect(stepUp().calls).toHaveLength(calls);
    });

    // -------------------------------------------------------------------------
    // 3. First writes and caps under parallel calls (Postgres pool variants: concurrency kit)
    // -------------------------------------------------------------------------

    it('race-1. web push: 40 parallel new browsers → at most 20 kept, the rest RATE_LIMITED, never a raw error; one endpoint 20× → one row', async () => {
      const browser = h.get(BrowserChannelProvider);
      const subs = h.dataSource.getRepository(InteractionWebPushSubscriptionEntity);
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) => browser.subscribe(owner(1), { endpoint: `${ENDPOINT}-${i}`, ...push }).then(() => 'ok', codeOf)));
      expect(results.every((result) => result === 'ok' || result === 'RATE_LIMITED')).toBe(true);
      const kept = await subs.count({ where: { userId: 1 } });
      expect(kept).toBeLessThanOrEqual(20);
      expect(kept).toBe(results.filter((result) => result === 'ok').length);
      expect(await h.dataSource.getRepository(InteractionUserChannelEntity).count({ where: { userId: 1, kind: 'browser' } })).toBe(1);
      const same = await Promise.all(Array.from({ length: 20 }, () => browser.subscribe(owner(2), { endpoint: ENDPOINT, ...push }).then(() => 'ok', codeOf)));
      expect(same).toEqual(Array(20).fill('ok'));
      expect(await subs.count({ where: { endpoint: ENDPOINT } })).toBe(1);
      expect(await h.dataSource.getRepository(InteractionUserChannelEntity).count({ where: { userId: 2, kind: 'browser' } })).toBe(1);
    });

    it('race-2. 10 parallel first configurations of a channel, and of an own Telegram bot: all succeed, one row, no orphan secret', async () => {
      const channels = h.get(InteractionChannelService);
      const results = await Promise.all(Array.from({ length: 10 }, () => channels.configure(owner(1), 'boom', {}).then(() => 'ok', codeOf)));
      expect(results).toEqual(Array(10).fill('ok'));
      expect(await h.dataSource.getRepository(InteractionUserChannelEntity).count({ where: { userId: 1, kind: 'boom' } })).toBe(1);
      h.telegram.addBot(BOT_TOKEN, BOT_TOKEN.split(':')[0], 'bot_of_1');
      const telegram = await Promise.all(Array.from({ length: 10 }, () => channels.configure(owner(1), 'telegram', { mode: 'own', token: BOT_TOKEN }).then(() => 'ok', codeOf)));
      expect(telegram).toEqual(Array(10).fill('ok'));
      const row = await h.dataSource.getRepository(InteractionUserChannelEntity).findOneByOrFail({ userId: 1, kind: 'telegram' });
      const secrets = await h.dataSource.getRepository(InteractionSecretEntity).find({ where: { ownerUserId: 1 } });
      expect(secrets.map((secret) => secret.id)).toEqual([row.secretId]);
    });

    it('race-3. 10 parallel first admin switches and 10 parallel first preference saves: all succeed, one row each', async () => {
      const channels = h.get(InteractionChannelService);
      expect(await Promise.all(Array.from({ length: 10 }, () => channels.adminSetDisabled({ userId: 9 }, 1, 'telegram', true).then(() => 'ok', codeOf)))).toEqual(Array(10).fill('ok'));
      const rows = await h.dataSource.getRepository(InteractionUserChannelEntity).find({ where: { userId: 1, kind: 'telegram' } });
      expect(rows.map((row) => row.adminDisabled)).toEqual([true]);
      const prefs = h.get(InteractionPrefService);
      expect(await Promise.all(Array.from({ length: 10 }, (_, i) => prefs.save(2, { criticalBypass: i % 2 === 0, timezone: 'UTC' }).then(() => 'ok', codeOf)))).toEqual(Array(10).fill('ok'));
      expect((await prefs.get(2)).timezone).toBe('UTC');
    });

    it('race-4. an administrator disables a channel while its owner configures it: the switch stays, the owner gets ADMIN_DISABLED, no orphan secret', async () => {
      const channels = h.get(InteractionChannelService);
      await channels.configure(owner(1), 'gated', {});
      const provider = h.get(GatedConfigureProvider);
      let release: () => void = () => undefined;
      provider.gate = new Promise<void>((resolve) => (release = resolve));
      const entered = new Promise<void>((resolve) => (provider.entered = resolve));
      const configuring = channels.configure(owner(1), 'gated', { again: true }).then(() => 'ok', codeOf);
      await entered;
      await channels.adminSetDisabled({ userId: 9 }, 1, 'gated', true);
      release();
      expect(await configuring).toBe('ADMIN_DISABLED');
      expect((await channels.rowOf(1, 'gated'))?.adminDisabled).toBe(true);
    });

    it('race-5. an owner’s write racing the administrator’s switch (PATCH, DELETE) never undoes it', async () => {
      const channels = h.get(InteractionChannelService);
      const repo = h.dataSource.getRepository(InteractionUserChannelEntity);
      for (const step of ['patch-position', 'patch-enable', 'delete'] as const) {
        await repo.delete({ userId: 1, kind: 'boom' });
        await channels.configure(owner(1), 'boom', {});
        // The administrator acts right after the owner's request has read the row (deterministic interleaving).
        const findOne = repo.findOne.bind(repo);
        const spy = jest.spyOn(repo, 'findOne').mockImplementationOnce(async (...args: Parameters<typeof repo.findOne>) => {
          const row = await findOne(...args);
          await channels.adminSetDisabled({ userId: 9 }, 1, 'boom', true);
          return row;
        });
        const result = await (step === 'delete' ? channels.remove(owner(1), 'boom') : channels.setState(owner(1), 'boom', step === 'patch-enable' ? { enabled: true } : { position: 3 })).then(() => 'ok', codeOf);
        spy.mockRestore();
        const row = await channels.rowOf(1, 'boom');
        expect([step, row?.adminDisabled]).toEqual([step, true]);
        if (step !== 'patch-position') expect(result).toBe('ADMIN_DISABLED');
        await channels.adminSetDisabled({ userId: 9 }, 1, 'boom', false);
      }
    });

    it('race-6. 12 parallel link codes: at most 5 pending, every code handed out is pending, the others RATE_LIMITED (no silently dead code)', async () => {
      const links = h.get(TelegramLinkService);
      const codes = h.dataSource.getRepository(InteractionLinkCodeEntity);
      const results = await Promise.all(Array.from({ length: 12 }, () => links.issueCode('u1', 1).then((issued) => issued.code, codeOf)));
      const handedOut = results.filter((result) => !['RATE_LIMITED'].includes(result) && !result.startsWith('raw:'));
      expect(results.every((result) => handedOut.includes(result) || result === 'RATE_LIMITED')).toBe(true);
      const pending = await codes.find({ where: { botRef: 'u1', userId: 1, usedAt: IsNull() } });
      expect(pending.length).toBeLessThanOrEqual(5);
      expect(handedOut.length).toBeGreaterThanOrEqual(1);
      // The newest five stay: the codes handed out last are pending; any code handed out earlier fell only to newer ones.
      const pendingHashes = new Set(pending.map((row) => row.codeHash));
      expect(handedOut.filter((code) => pendingHashes.has(hashCode(code))).length).toBe(Math.min(5, pending.length));
      // Sequentially, the rule is exact: the oldest falls, the five newest stay.
      const sequence: string[] = [];
      for (let i = 0; i < 7; i += 1) sequence.push((await links.issueCode('u2', 2)).code);
      const kept = new Set((await codes.find({ where: { botRef: 'u2', userId: 2, usedAt: IsNull() } })).map((row) => row.codeHash));
      expect(sequence.map((code) => kept.has(hashCode(code)))).toEqual([false, false, true, true, true, true, true]);
    });

    // -------------------------------------------------------------------------
    // 5. No secret anywhere, whatever the Bot API or the push service does
    // -------------------------------------------------------------------------

    it('leak-1. Bot API and push service failing in every way: no token, webhook secret, link code nor endpoint in logs, errors, audit or rows', async () => {
      await h.close();
      h = await harness({ realTelegramClient: true, webPushSender: new FailingPushSender() }, { interaction_providerTimeoutMs: 10_000 });
      const secretPart = BOT_TOKEN.split(':')[1];
      const webhookSecret = h.get(InteractionKeyService).webhookSecret('u1', BOT_TOKEN.split(':')[0]);
      let mode: Record<string, (url: string, init: RequestInit) => Promise<Response>> = {};
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = url.split('/').pop() as string;
        const behave = mode[method] ?? (async () => new Response(JSON.stringify({ ok: false, description: `Not Found ${url}` }), { status: 404 }));
        return behave(url, init ?? {});
      });
      const errors: string[] = [];
      const capture = async (work: Promise<unknown>): Promise<string> =>
        work.then(
          () => 'ok',
          (error: unknown) => {
            errors.push(String(error), JSON.stringify(error), String((error as Error)?.stack ?? ''));
            return codeOf(error);
          },
        );
      const channels = h.get(InteractionChannelService);
      // getMe: a network error quoting the URL, then a body echoing the token.
      mode = { getMe: async (url) => Promise.reject(new Error(`request to ${url} failed, reason: ECONNRESET`)) };
      expect(await capture(channels.configure(owner(1), 'telegram', { mode: 'own', token: BOT_TOKEN }))).toBe('UPSTREAM_UNAVAILABLE');
      mode = { getMe: async () => new Response(JSON.stringify({ ok: false, description: `Unauthorized ${BOT_TOKEN}` }), { status: 401 }) };
      expect(await capture(channels.configure(owner(1), 'telegram', { mode: 'own', token: BOT_TOKEN }))).toBe('INVALID_CONFIG');
      mode = { getMe: async () => new Response(JSON.stringify({ ok: true, result: { id: 7000001, is_bot: true, username: 'bot_of_1' } }), { status: 200 }) };
      expect(await capture(channels.configure(owner(1), 'telegram', { mode: 'own', token: BOT_TOKEN }))).toBe('ok');
      // Linking: the code is shown once to its owner; the bot's reply fails (401 echoing the token).
      mode = { sendMessage: async () => new Response(JSON.stringify({ ok: false, description: `Forbidden ${BOT_TOKEN}` }), { status: 401 }) };
      const { code, deepLink } = await h.get(TelegramChannelProvider).linkCode(owner(1));
      expect(deepLink).toContain(code);
      await h.get(TelegramUpdateHandler).handle('u1', BOT_TOKEN, startUpdate(1, TG_ACCOUNT, code));
      // Deliveries: Telegram fails (401 echoing the token), Web Push fails (500 quoting the endpoint).
      await h.get(BrowserChannelProvider).subscribe(owner(1), { endpoint: ENDPOINT, ...push });
      const report = await h.get(UserInteractionService).notify(1, { type: 'test.notice', source: 'tests', category: 'security', title: { raw: 'Hello there' } });
      expect(report.deliveries.find((d) => d.kind === 'telegram')).toEqual({ kind: 'telegram', status: 'failed', code: 'TELEGRAM_401' });
      expect(report.deliveries.find((d) => d.kind === 'browser')).toEqual({ kind: 'browser', status: 'failed', code: 'HTTP_500' });
      await h.get(UserInteractionService).ask(1, question());
      await idle(h);
      // A press answered with invalid JSON; a test send timing out (an abort quoting the URL).
      mode = { answerCallbackQuery: async () => new Response(`<html>${BOT_TOKEN}</html>`, { status: 200 }), sendMessage: async (url) => Promise.reject(Object.assign(new Error(`aborted ${url}`), { name: 'AbortError' })) };
      await h.get(TelegramUpdateHandler).handle('u1', BOT_TOKEN, pressUpdate(5, { account: TG_ACCOUNT, chatId: TG_ACCOUNT, messageId: '99', data: `ix:${'A'.repeat(12)}:0:${'B'.repeat(8)}` }));
      expect((await http(h).post('/api/v1/interaction/me/channels/telegram/test').set('Authorization', 'Bearer user-1')).body).toEqual({ ok: false, code: 'TELEGRAM_0' });
      // Webhook mode: setWebhook fails (network error quoting the URL); a forged secret is a plain 404.
      h.config.values.set('interaction_telegramInbound', 'webhook');
      mode = { setWebhook: async (url) => Promise.reject(new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED ${url}`) })) };
      await h.get(TelegramBotFleet).reconcile();
      expect((await h.dataSource.getRepository(InteractionTelegramBotEntity).findOneByOrFail({ id: 'u1' })).lastError).toBe('TELEGRAM_0');
      expect((await http(h).post('/api/v1/interaction/telegram/webhook/u1/7000001').set('X-Telegram-Bot-Api-Secret-Token', 'forged').send({ update_id: 1 })).status).toBe(404);
      expect((await http(h).post('/api/v1/interaction/telegram/webhook/u1/7000001').set('X-Telegram-Bot-Api-Secret-Token', webhookSecret).send({ update_id: 2 })).status).toBe(200);
      await idle(h);
      // Every place a secret could land.
      // The endpoint's one home is its subscription row (a target, never journaled); no secret is anywhere at all.
      const rows: string[] = [];
      for (const entity of INTERACTION_ENTITIES) if (entity !== InteractionWebPushSubscriptionEntity) rows.push(JSON.stringify(await h.dataSource.getRepository(entity).find()));
      const subscriptions = JSON.stringify(await h.dataSource.getRepository(InteractionWebPushSubscriptionEntity).find());
      expect(subscriptions).toContain('abc-endpoint-secret');
      const everything = [...h.logs, ...errors, ...rows, JSON.stringify(report)].join('\n');
      for (const leak of [secretPart, webhookSecret, code, 'abc-endpoint-secret', 'push.example.test', 'api.telegram.org/bot']) expect(everything).not.toContain(leak);
      for (const leak of [secretPart, webhookSecret, code]) expect(subscriptions).not.toContain(leak);
      // Not vacuous: the failures did happen and were journaled by code.
      expect(h.logs.some((line) => line.includes('fetch failed (NETWORK)'))).toBe(true);
      expect(h.logs.some((line) => line.includes('telegram.link_code'))).toBe(true);
      expect(await h.dataSource.getRepository(InteractionDeliveryEntity).count({ where: { kind: 'browser', code: 'HTTP_500' } })).toBe(2);
      expect(await h.dataSource.getRepository(InteractionLinkCodeEntity).count({ where: { codeHash: hashCode(code) } })).toBe(1);
    }, 60_000);
  });
}
