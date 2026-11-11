/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Postgres-only concurrency tests of the module (contract 04 §8, §9, §17 tests 4, 9, 10, 11, 12, 15, 17; plus the races
// of the hardening of lot C1: web push subscriptions and their cap, first writes of channels / preferences / the admin
// switch, the owner against the admin switch, link code issuance, step-up proofs consumed by the winner only; and of the
// review: one bot per user, five links per bot, one handling per webhook update). SQLite runs on
// ONE connection, which serializes everything and hides races: here the Postgres pool has several connections
// (`poolSize`), every contender is launched at once with `Promise.all`, and `trackPoolUsage` PROVES that several
// connections were checked out at the same time. Each test loops `INTERACTION_CONCURRENCY_ROUNDS` times (default 5) on
// fresh tickets / codes / counters, so a CI run can raise it (20 for a soak) without changing the code.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { In, IsNull, Not } from 'typeorm';
import { InteractionLinkCodeEntity } from '../entities/InteractionLinkCodeEntity';
import { InteractionNoticeEntity } from '../entities/InteractionNoticeEntity';
import { InteractionSecretEntity } from '../entities/InteractionSecretEntity';
import { InteractionSendCounterEntity } from '../entities/InteractionSendCounterEntity';
import { InteractionTelegramBotEntity } from '../entities/InteractionTelegramBotEntity';
import { InteractionTelegramLinkEntity } from '../entities/InteractionTelegramLinkEntity';
import { InteractionTicketCardEntity } from '../entities/InteractionTicketCardEntity';
import { InteractionTicketEntity } from '../entities/InteractionTicketEntity';
import { InteractionTicketRecipientEntity } from '../entities/InteractionTicketRecipientEntity';
import { InteractionUserChannelEntity } from '../entities/InteractionUserChannelEntity';
import { InteractionWebPushSubscriptionEntity } from '../entities/InteractionWebPushSubscriptionEntity';
import { isInteractionError } from '../errors/InteractionError';
import { hashCode } from '../pure/codes';
import { TelegramLinkService } from '../providers/telegram/TelegramLinkService';
import { TelegramBotStateStore } from '../providers/telegram/TelegramBotStateStore';
import { TelegramUpdateHandler } from '../providers/telegram/TelegramUpdateHandler';
import { BrowserChannelProvider } from '../providers/browser/BrowserChannelProvider';
import { InteractionChannelService } from '../services/InteractionChannelService';
import { InteractionPrefService } from '../services/InteractionPrefService';
import { InteractionMaintenanceService } from '../services/InteractionMaintenanceService';
import { InteractionSendQuotaService } from '../services/InteractionSendQuotaService';
import { InteractionTicketService } from '../services/InteractionTicketService';
import { UserInteractionService } from '../services/UserInteractionService';
import type { InteractionAnswer } from '../types/interactionTypes';
import { stepUpPurposeOf } from '../types/ports';
import { BOT_TOKEN, BOT_TOKEN_2, ENABLED, EXTRA, ENDPOINT, idle, lastCard, linkOwnTelegram, notice, owner, question } from './interactionConformance.testkit';
import { GatedStepUp } from './interactionHardening.testkit';
import { createInteractionHarness, trackPoolUsage, type Harness, type HarnessDatabase, type PoolUsage } from './interactionHarness';

const ROUNDS = Math.max(1, Number(process.env.INTERACTION_CONCURRENCY_ROUNDS ?? 5));
const POOL = 24;

export interface ConcurrencyOptions {
  /** A fresh Postgres schema per call (dropped by the caller). */
  database: () => HarnessDatabase;
}

const rounds = <T>(run: (round: number) => Promise<T>): Promise<T[]> => {
  const out: Promise<T>[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  for (let round = 0; round < ROUNDS; round += 1) {
    const step = chain.then(() => run(round));
    out.push(step);
    chain = step;
  }
  return Promise.all(out);
};

const codeOf = (error: unknown): string => (isInteractionError(error) ? error.code : `error:${String((error as Error)?.message ?? error)}`);

export function describeInteractionConcurrency(label: string, options: ConcurrencyOptions): void {
  describe(`interaction concurrency (04 §8, §9, §17) — ${label}`, () => {
    let h: Harness;
    let pool: PoolUsage;
    let handled: InteractionAnswer[];

    beforeEach(async () => {
      handled = [];
      h = await createInteractionHarness({ database: options.database(), poolSize: POOL, config: { interaction_enabledKinds: ENABLED, interaction_providerTimeoutMs: 1000, interaction_maxPerUserHour: 100_000, interaction_askMaxPerUserHour: 100_000 }, providers: EXTRA, stepUp: GatedStepUp });
      for (const id of [1, 2, 3]) h.directory.add(id);
      h.directory.add(9, { admin: true });
      h.get(UserInteractionService).onAnswer('test.approval', async (answer) => {
        handled.push(answer);
      });
      pool = trackPoolUsage(h.dataSource);
    });

    afterEach(async () => {
      pool.stop();
      await idle(h).catch(() => undefined);
      await h.close();
    });

    /** Raw SQL goes through the schema of the test (the connection's search_path is not set). */
    const table = (name: string): string => `"${(h.dataSource.options as { schema: string }).schema}"."${name}"`;
    const rowOf = (id: string) => h.dataSource.getRepository(InteractionTicketEntity).findOneByOrFail({ id });
    const outcomesOf = (ticketId: string) => handled.filter((entry) => entry.ticketId === ticketId);
    /** The contenders really ran on several connections at the same time. */
    const expectParallel = (min = 4): void => expect(pool.peak()).toBeGreaterThanOrEqual(min);

    it('9-pg. 50 answers in parallel on a pool (in-app + Telegram): ONE winner, the others ALREADY_ANSWERED, outcome handed over once', async () => {
      const tg = await linkOwnTelegram(h, 1);
      const tickets = h.get(InteractionTicketService);
      const handler = h.get(TelegramUpdateHandler);
      const frames = await h.listen({ id: 1, admin: false, kind: 'user' });
      let telegramWins = 0;
      await rounds(async (round) => {
        const ticket = await h.get(UserInteractionService).ask(1, question({ correlationId: `race-${round}` }));
        await idle(h);
        const card = lastCard(h);
        pool.reset();
        const contenders: Array<Promise<{ who: string; result: string }>> = [];
        for (let i = 0; i < 25; i += 1) {
          const index = i % 2;
          contenders.push(tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: ['approve', 'deny'][index] }).then(() => ({ who: `inapp:${['approve', 'deny'][index]}`, result: 'won' }), (error: unknown) => ({ who: 'inapp', result: codeOf(error) })));
          contenders.push(handler.cardPress(tg.botRef, { callbackId: `c${round}-${i}`, telegramUserId: tg.account, chatId: tg.account, messageId: card.messageId, data: card.data[index], languageCode: 'en' }).then((verdict) => ({ who: `telegram:${['approve', 'deny'][index]}`, result: verdict.ok ? 'won' : verdict.reason }), () => ({ who: 'telegram', result: 'threw' })));
        }
        const results = await Promise.all(contenders);
        expectParallel();
        const winners = results.filter((r) => r.result === 'won');
        expect(winners).toHaveLength(1);
        const losers = results.filter((r) => r.result !== 'won');
        expect(losers.filter((r) => r.who === 'inapp').every((r) => r.result === 'ALREADY_ANSWERED')).toBe(true);
        expect(losers.filter((r) => r.who.startsWith('telegram')).every((r) => r.result === 'ALREADY_ANSWERED' || r.result === 'UNKNOWN_CARD')).toBe(true);
        const [via, action] = winners[0].who.split(':');
        if (via === 'telegram') telegramWins += 1;
        await idle(h);
        const row = await rowOf(ticket.id);
        expect([row.status, row.answeredVia, row.answerAction, row.answeredBy, row.dispatchStatus]).toEqual(['answered', via, action, 1, 'done']);
        // Side effects of the winner only, exactly once.
        expect(outcomesOf(ticket.id)).toEqual([expect.objectContaining({ status: 'answered', actionId: action, via, answeredBy: 1 })]);
        const cards = await h.dataSource.getRepository(InteractionTicketCardEntity).find({ where: { ticketId: ticket.id } });
        expect(cards.every((c) => c.state === 'closed')).toBe(true);
        expect(h.telegram.calls.filter((c) => c.method === 'editMessageText' && c.messageId === card.messageId)).toHaveLength(1);
        expect(JSON.stringify(frames.filter((f) => f.name === 'event')).split(ticket.id).length - 1).toBeGreaterThanOrEqual(1);
        expect(frames.filter((f) => JSON.stringify(f.data).includes('ticket.closed') && JSON.stringify(f.data).includes(ticket.id))).toHaveLength(1);
        expect(await h.dataSource.getRepository(InteractionNoticeEntity).count({ where: { userId: 1, type: 'interaction.answered_elsewhere' } })).toBe(telegramWins);
      });
    });

    it('10-pg. answers, sweeps and a cancel racing on an expired-by-clock ticket: one terminal state, one outcome, consistent with the row', async () => {
      const tickets = h.get(InteractionTicketService);
      const seen = { answered: 0, expired: 0, cancelled: 0 };
      await rounds(async (round) => {
        const ticket = await h.get(UserInteractionService).ask(1, question({ correlationId: `expiry-${round}` }));
        const end = new Date(Date.now() + 5_000);
        await h.dataSource.getRepository(InteractionTicketEntity).update({ id: ticket.id }, { expiresAt: end });
        const afterEnd = new Date(end.getTime() + 1);
        pool.reset();
        const answers = Array.from({ length: 20 }, () => tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'approve' }).then(() => 'won', codeOf));
        const sweeps = Array.from({ length: 5 }, () => tickets.expireDue(afterEnd));
        const cancel = tickets.cancelById(ticket.id, 'race');
        const [answerResults, sweepResults, cancelled] = await Promise.all([Promise.all(answers), Promise.all(sweeps), cancel]);
        expectParallel();
        await idle(h);
        const row = await rowOf(ticket.id);
        expect(['answered', 'expired', 'cancelled']).toContain(row.status);
        const won = answerResults.filter((r) => r === 'won').length;
        const expiredCount = sweepResults.reduce((sum, n) => sum + n, 0);
        // Exactly one door out of `open`.
        expect([won, expiredCount, cancelled ? 1 : 0].reduce((a, b) => a + b, 0)).toBe(1);
        expect(won).toBe(row.status === 'answered' ? 1 : 0);
        expect(expiredCount).toBe(row.status === 'expired' ? 1 : 0);
        expect(cancelled).toBe(row.status === 'cancelled');
        const losers = { answered: ['ALREADY_ANSWERED'], expired: ['EXPIRED'], cancelled: ['CANCELLED'] }[row.status as 'answered' | 'expired' | 'cancelled'];
        expect(answerResults.filter((r) => r !== 'won').every((r) => losers.includes(r))).toBe(true);
        expect(outcomesOf(ticket.id)).toEqual([expect.objectContaining({ status: row.status })]);
        expect(row.dispatchStatus).toBe('done');
        seen[row.status as keyof typeof seen] += 1;
      });
      expect(seen.answered + seen.expired + seen.cancelled).toBe(ROUNDS);
    });

    it('10b-pg. answers landing around the real expires_at: a late one is EXPIRED, the handler never gets « answered » for an expired ticket', async () => {
      const tickets = h.get(InteractionTicketService);
      await rounds(async (round) => {
        const ticket = await h.get(UserInteractionService).ask(1, question({ correlationId: `edge-${round}` }));
        await h.dataSource.getRepository(InteractionTicketEntity).update({ id: ticket.id }, { expiresAt: new Date(Date.now() + 40) });
        pool.reset();
        const results = await Promise.all(
          Array.from({ length: 40 }, (_, i) =>
            new Promise<void>((resolve) => setTimeout(resolve, (i * 3) % 80)).then(() => tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'approve' }).then(() => 'won', codeOf)),
          ),
        );
        expectParallel(2);
        await idle(h);
        const winners = results.filter((r) => r === 'won').length;
        expect(winners).toBeLessThanOrEqual(1);
        expect(results.filter((r) => r !== 'won').every((r) => r === 'EXPIRED' || r === 'ALREADY_ANSWERED')).toBe(true);
        const row = await rowOf(ticket.id);
        if (winners === 1) {
          expect(row.status).toBe('answered');
          expect(row.answeredAt && row.answeredAt.getTime()).toBeLessThanOrEqual(row.expiresAt.getTime());
          expect(outcomesOf(ticket.id)).toEqual([expect.objectContaining({ status: 'answered' })]);
        } else {
          expect(row.status).toBe('open');
          expect(outcomesOf(ticket.id)).toHaveLength(0);
          expect(results.every((r) => r === 'EXPIRED')).toBe(true);
        }
        await Promise.all([tickets.expireDue(), tickets.expireDue()]);
        await idle(h);
        const after = await rowOf(ticket.id);
        expect(outcomesOf(ticket.id)).toHaveLength(1);
        expect(outcomesOf(ticket.id)[0].status).toBe(after.status);
      });
    });

    it('11-pg. parallel sweeps hand « expired » over once per ticket and close each card once', async () => {
      await linkOwnTelegram(h, 1);
      const tickets = h.get(InteractionTicketService);
      await rounds(async (round) => {
        const created = [];
        for (let i = 0; i < 6; i += 1) created.push(await h.get(UserInteractionService).ask(1, question({ correlationId: `sweep-${round}-${i}` })));
        await idle(h);
        const ids = created.map((t) => t.id);
        await h.dataSource.getRepository(InteractionTicketEntity).update({ id: In(ids) }, { expiresAt: new Date(Date.now() - 1000) });
        pool.reset();
        const counts = await Promise.all(Array.from({ length: 6 }, () => tickets.expireDue()));
        expectParallel();
        await idle(h);
        expect(counts.reduce((a, b) => a + b, 0)).toBe(6);
        for (const id of ids) {
          expect(outcomesOf(id)).toEqual([expect.objectContaining({ status: 'expired', actionId: null })]);
          expect((await rowOf(id)).dispatchStatus).toBe('done');
        }
        const cards = await h.dataSource.getRepository(InteractionTicketCardEntity).find({ where: { ticketId: In(ids) } });
        expect(cards).toHaveLength(6);
        expect(cards.every((c) => c.state === 'closed')).toBe(true);
        for (const card of cards) expect(h.telegram.calls.filter((c) => c.method === 'editMessageText' && c.messageId === (card.binding as Record<string, string>).messageId)).toHaveLength(1);
      });
    });

    it('12-pg. 20 parallel retry jobs after a failed hand-over: the handler succeeds once (claim by conditional UPDATE)', async () => {
      const tickets = h.get(InteractionTicketService);
      let calls = 0;
      h.get(UserInteractionService).onAnswer('test.flaky', async () => {
        calls += 1;
        if (calls === 1) throw new Error('handler down');
      });
      await rounds(async (round) => {
        calls = 0;
        const ticket = await h.get(UserInteractionService).ask(1, question({ kind: 'test.flaky', correlationId: `flaky-${round}` }));
        await tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'deny' });
        await idle(h);
        expect(calls).toBe(1);
        pool.reset();
        const later = new Date(Date.now() + 15_000);
        await Promise.all(Array.from({ length: 20 }, () => tickets.retryDispatches(later)));
        expectParallel();
        expect(calls).toBe(2);
        const row = await rowOf(ticket.id);
        expect([row.dispatchStatus, row.dispatchAttempts]).toEqual(['done', 1]);
      });
    });

    it('15-pg. link codes: 50 parallel consumptions of one code → one link; two users racing for one Telegram account never both keep it', async () => {
      const provider = h.get(TelegramLinkService);
      const links = h.dataSource.getRepository(InteractionTelegramLinkEntity);
      h.telegram.addBot(BOT_TOKEN, '7000001', 'bot_of_1');
      h.telegram.addBot(BOT_TOKEN_2, '7000002', 'bot_of_2');
      await rounds(async (round) => {
        await links.clear();
        const account = String(880_000_000 + round);
        const { code } = await provider.issueCode('u1', 1);
        pool.reset();
        const start = { telegramUserId: account, chatId: account, code, label: null, languageCode: null };
        const outcomes = await Promise.all(Array.from({ length: 50 }, () => provider.consume('u1', start)));
        expectParallel();
        expect(outcomes.filter((o) => o === 'linked')).toHaveLength(1);
        expect(outcomes.filter((o) => o === 'invalid')).toHaveLength(49);
        expect(await links.count({ where: { botRef: 'u1', telegramUserId: account } })).toBe(1);

        // The same Telegram account claimed by two users on two bots, 4 accounts at once (at most 5 pending codes per user and bot).
        const accounts = Array.from({ length: 4 }, (_, i) => String(770_000_000 + round * 10 + i));
        const issued = await Promise.all(accounts.flatMap((a) => [provider.issueCode('u1', 1).then((c) => ({ a, botRef: 'u1', code: c.code })), provider.issueCode('u2', 2).then((c) => ({ a, botRef: 'u2', code: c.code }))]));
        pool.reset();
        const raced = await Promise.all(issued.map(({ a, botRef, code: c }) => provider.consume(botRef, { telegramUserId: a, chatId: a, code: c, label: null, languageCode: null }).then((outcome) => ({ a, botRef, outcome }))));
        expectParallel();
        for (const a of accounts) {
          const owners = new Set((await links.find({ where: { telegramUserId: a } })).map((l) => l.userId));
          expect(owners.size).toBeLessThanOrEqual(1);
          const kept = raced.filter((r) => r.a === a && r.outcome === 'linked').length;
          expect(kept).toBeLessThanOrEqual(1);
          expect(await links.count({ where: { telegramUserId: a } })).toBe(owners.size === 0 ? 0 : 1);
          expect(raced.filter((r) => r.a === a).every((r) => ['linked', 'conflict'].includes(r.outcome) || r.outcome === 'limit')).toBe(true);
        }
      });
    });

    it('17-pg. send caps under parallelism: never more admitted than the cap, refused sends leave no row, the exact cap is fully admitted', async () => {
      const quota = h.get(InteractionSendQuotaService);
      const sends = h.dataSource.getRepository(InteractionSendCounterEntity);
      await rounds(async (round) => {
        const user = 100 + round;
        // 5 parallel sends against a cap of 5: nobody can see more than 5 rows, all are admitted.
        h.config.values.set('interaction_testsPerUserHour', 5);
        h.config.values.set('interaction_testsPerIpHour', 1000);
        h.config.values.set('interaction_testsGlobalHour', 100_000);
        pool.reset();
        const exact = await Promise.all(Array.from({ length: 5 }, () => quota.take('channel_test', { userId: user }).then(() => 'ok', codeOf)));
        expectParallel(2);
        expect(exact).toEqual(Array(5).fill('ok'));
        await expect(quota.take('channel_test', { userId: user })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
        expect(await sends.count({ where: { userId: user, kind: 'channel_test' } })).toBe(5);

        // 40 parallel sends against a cap of 3 (other user): at most 3 admitted (« may both be refused, never both admitted »).
        const other = 300 + round;
        h.config.values.set('interaction_linkCodesPerUserHour', 3);
        pool.reset();
        const burst = await Promise.all(Array.from({ length: 40 }, () => quota.take('link_code', { userId: other }).then(() => 'ok', codeOf)));
        expectParallel();
        const admitted = burst.filter((r) => r === 'ok').length;
        expect(admitted).toBeLessThanOrEqual(3);
        expect(burst.filter((r) => r !== 'ok').every((r) => r === 'RATE_LIMITED')).toBe(true);
        expect(await sends.count({ where: { userId: other, kind: 'link_code' } })).toBe(admitted);

        // Per address (e-mail codes): 3 a day for one address across 10 users in parallel.
        h.config.values.set('interaction_emailCodesPerUserHour', 100);
        h.config.values.set('interaction_emailCodesPerIpHour', 1000);
        h.config.values.set('interaction_emailCodesGlobalHour', 10_000);
        h.config.values.set('interaction_emailCodesPerAddressDay', 3);
        const target = `target-${round}@example.test`;
        const emails = await Promise.all(Array.from({ length: 10 }, (_, i) => quota.take('email_code', { userId: 500 + round * 20 + i, target }).then(() => 'ok', codeOf)));
        const sentEmails = emails.filter((r) => r === 'ok').length;
        expect(sentEmails).toBeLessThanOrEqual(3);
        expect(emails.filter((r) => r !== 'ok').every((r) => r === 'RATE_LIMITED')).toBe(true);

        // Global cap across users.
        h.config.values.set('interaction_testsPerUserHour', 100);
        h.config.values.set('interaction_testsPerIpHour', 1000);
        const before = await sends.count({ where: { kind: 'channel_test' } });
        h.config.values.set('interaction_testsGlobalHour', before + 4);
        const global = await Promise.all(Array.from({ length: 20 }, (_, i) => quota.take('channel_test', { userId: 700 + round * 30 + i }).then(() => 'ok', codeOf)));
        expect(global.filter((r) => r === 'ok').length).toBeLessThanOrEqual(4);
        expect(await sends.count({ where: { kind: 'channel_test' } })).toBe(before + global.filter((r) => r === 'ok').length);
      });
    });

    it('17b-pg. the per-user hourly cap of deliveries holds under 30 parallel notify (distinct dedup keys)', async () => {
      await linkOwnTelegram(h, 1);
      h.config.values.set('interaction_maxPerUserHour', 3);
      pool.reset();
      const reports = await Promise.all(Array.from({ length: 30 }, (_, i) => h.get(UserInteractionService).notify(1, notice({ category: 'security', dedupKey: `cap-${i}` }))));
      expectParallel();
      await idle(h);
      const sent = reports.filter((r) => r.deliveries.find((d) => d.kind === 'telegram')?.status === 'sent').length;
      expect(sent).toBeLessThanOrEqual(3);
      expect(h.telegram.sent().filter((call) => call.text?.includes('Hello there'))).toHaveLength(sent);
      expect(reports.flatMap((r) => r.deliveries.filter((d) => d.kind === 'telegram' && d.status !== 'sent')).every((d) => d.status === 'skipped' && d.code === 'CAPPED')).toBe(true);
    });

    it('4-pg. 30 parallel notify with one dedupKey and 30 parallel ask with one correlationId: one of each, the rest duplicate / the same ticket', async () => {
      await linkOwnTelegram(h, 1);
      await rounds(async (round) => {
        pool.reset();
        const reports = await Promise.all(Array.from({ length: 30 }, () => h.get(UserInteractionService).notify(1, notice({ dedupKey: `same-${round}` }))));
        expectParallel();
        for (const kind of ['inapp', 'telegram']) {
          const statuses = reports.map((r) => r.deliveries.find((d) => d.kind === kind)?.status);
          expect(statuses.filter((s) => s === 'sent')).toHaveLength(1);
          expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(29);
        }
        pool.reset();
        const asked = await Promise.all(Array.from({ length: 30 }, () => h.get(UserInteractionService).ask(1, question({ correlationId: `once-${round}` }))));
        expectParallel();
        await idle(h);
        const ids = new Set(asked.map((t) => t.id));
        expect(ids.size).toBe(1);
        const [id] = [...ids];
        expect(await h.dataSource.getRepository(InteractionTicketEntity).count({ where: { source: 'tests', correlationId: `once-${round}` } })).toBe(1);
        expect(await h.dataSource.getRepository(InteractionTicketRecipientEntity).count({ where: { ticketId: id } })).toBe(1);
        expect(await h.dataSource.getRepository(InteractionNoticeEntity).count({ where: { ticketId: id } })).toBe(1);
        expect(await h.dataSource.getRepository(InteractionTicketCardEntity).count({ where: { ticketId: id } })).toBe(1);
      });
    });

    it('lease. 20 pollers racing for one bot lease: exactly one holds it; counters stay exact', async () => {
      const store = h.get(TelegramBotStateStore);
      await store.patch('u1', { enabled: true, status: 'starting' });
      await rounds(async (round) => {
        await h.dataSource.getRepository(InteractionTelegramBotEntity).update({ id: 'u1' }, { leaseOwner: null, leaseUntil: null, receivedCount: 0 });
        pool.reset();
        const now = new Date();
        const got = await Promise.all(Array.from({ length: 20 }, (_, i) => store.tryLease('u1', `owner-${round}-${i}`, now, 30_000)));
        expectParallel();
        expect(got.filter(Boolean)).toHaveLength(1);
        const row = await h.dataSource.getRepository(InteractionTelegramBotEntity).findOneByOrFail({ id: 'u1' });
        expect(row.leaseOwner).toBe(`owner-${round}-${got.indexOf(true)}`);
        await Promise.all(Array.from({ length: 50 }, () => store.increment('u1', 'receivedCount')));
        expect((await h.dataSource.getRepository(InteractionTelegramBotEntity).findOneByOrFail({ id: 'u1' })).receivedCount).toBe(50);
        const fresh = await Promise.all(Array.from({ length: 10 }, () => store.load(`u${900 + round}`)));
        expect(new Set(fresh.map((r) => r.id)).size).toBe(1);
      });
    });

    it('web push. parallel subscriptions: one endpoint 20× → one row, all succeed; 40 new browsers → at most 20 kept, the rest RATE_LIMITED, never a raw error', async () => {
      const browser = h.get(BrowserChannelProvider);
      const subs = h.dataSource.getRepository(InteractionWebPushSubscriptionEntity);
      const channels = h.dataSource.getRepository(InteractionUserChannelEntity);
      const body = (endpoint: string) => ({ endpoint, keys: { p256dh: 'BPk' + 'a'.repeat(80), auth: 'auth' + 'b'.repeat(18) }, userAgent: 'Test/1.0' });
      await rounds(async (round) => {
        const user = 10 + round;
        pool.reset();
        const same = await Promise.all(Array.from({ length: 20 }, () => browser.subscribe(owner(user), body(`${ENDPOINT}-same-${round}`)).then(() => 'ok', codeOf)));
        expectParallel();
        expect(same).toEqual(Array(20).fill('ok'));
        expect(await subs.count({ where: { endpoint: `${ENDPOINT}-same-${round}` } })).toBe(1);
        expect(await channels.count({ where: { userId: user, kind: 'browser' } })).toBe(1);
        const other = 50 + round;
        pool.reset();
        const many = await Promise.all(Array.from({ length: 40 }, (_, i) => browser.subscribe(owner(other), body(`${ENDPOINT}-${round}-${i}`)).then(() => 'ok', codeOf)));
        expectParallel();
        expect(many.every((r) => r === 'ok' || r === 'RATE_LIMITED')).toBe(true);
        const kept = await subs.count({ where: { userId: other } });
        expect(kept).toBeLessThanOrEqual(20);
        expect(kept).toBe(many.filter((r) => r === 'ok').length);
        expect(await channels.count({ where: { userId: other, kind: 'browser' } })).toBe(1);
      });
    });

    it('first writes. parallel first saves of the preferences, of a channel, of an own Telegram bot and of the admin switch: all succeed, one row each, no orphan secret', async () => {
      const prefs = h.get(InteractionPrefService);
      const channels = h.get(InteractionChannelService);
      await rounds(async (round) => {
        const user = 200 + round;
        h.directory.add(user);
        pool.reset();
        const results = await Promise.all([
          ...Array.from({ length: 10 }, (_, i) => prefs.save(user, { criticalBypass: i % 2 === 0 }).then(() => 'ok', codeOf)),
          ...Array.from({ length: 10 }, () => channels.configure(owner(user), 'boom', {}).then(() => 'ok', codeOf)),
          ...Array.from({ length: 10 }, () => channels.adminSetDisabled({ userId: 9 }, user, 'slow', true).then(() => 'ok', codeOf)),
        ]);
        expectParallel();
        expect(results).toEqual(Array(30).fill('ok'));
        const rows = h.dataSource.getRepository(InteractionUserChannelEntity);
        expect(await rows.count({ where: { userId: user, kind: 'boom' } })).toBe(1);
        expect((await rows.find({ where: { userId: user, kind: 'slow' } })).map((row) => row.adminDisabled)).toEqual([true]);
        expect(typeof (await prefs.get(user)).criticalBypass).toBe('boolean');
        const token = `${7100000 + round}:AAH-test-token-of-round-${round}-0123456789`;
        h.telegram.addBot(token, token.split(':')[0], `bot_r${round}`);
        pool.reset();
        const telegram = await Promise.all(Array.from({ length: 10 }, () => channels.configure(owner(user), 'telegram', { mode: 'own', token }).then(() => 'ok', codeOf)));
        expectParallel();
        expect(telegram).toEqual(Array(10).fill('ok'));
        const row = await rows.findOneByOrFail({ userId: user, kind: 'telegram' });
        expect((await h.dataSource.getRepository(InteractionSecretEntity).find({ where: { ownerUserId: user } })).map((secret) => secret.id)).toEqual([row.secretId]);
      });
    });

    it('admin switch. an owner hammering PATCH while an administrator disables the channel: the switch always stays', async () => {
      const channels = h.get(InteractionChannelService);
      await rounds(async (round) => {
        const user = 400 + round;
        h.directory.add(user);
        await channels.configure(owner(user), 'boom', {});
        pool.reset();
        const results = await Promise.all([
          ...Array.from({ length: 20 }, (_, i) => channels.setState(owner(user), 'boom', i % 2 === 0 ? { position: i } : { enabled: true }).then(() => 'ok', codeOf)),
          channels.adminSetDisabled({ userId: 9 }, user, 'boom', true).then(() => 'ok', codeOf),
          ...Array.from({ length: 5 }, () => channels.remove(owner(user), 'boom').then(() => 'ok', codeOf)),
        ]);
        expectParallel();
        expect(results.every((r) => r === 'ok' || r === 'ADMIN_DISABLED' || r === 'NOT_FOUND' || r === 'NOT_CONFIGURED')).toBe(true);
        const row = await channels.rowOf(user, 'boom');
        // Either the owner removed it before the switch existed (then the switch created a disabled row), or it is disabled.
        expect(row?.adminDisabled).toBe(true);
      });
    });

    it('15b-pg. 12 parallel link codes of one user: at most 5 pending, only codes or RATE_LIMITED, every pending code was handed out', async () => {
      const links = h.get(TelegramLinkService);
      const codes = h.dataSource.getRepository(InteractionLinkCodeEntity);
      await rounds(async (round) => {
        const user = 600 + round;
        pool.reset();
        const results = await Promise.all(Array.from({ length: 12 }, () => links.issueCode(`u${user}`, user).then((issued) => issued.code, codeOf)));
        expectParallel();
        const handedOut = results.filter((r) => /^[A-Za-z0-9_-]{43}$/.test(r));
        expect(results.every((r) => handedOut.includes(r) || r === 'RATE_LIMITED')).toBe(true);
        const pending = await codes.find({ where: { botRef: `u${user}`, userId: user, usedAt: IsNull() } });
        expect(pending.length).toBeLessThanOrEqual(5);
        expect(pending.length).toBeGreaterThanOrEqual(1);
        const hashes = new Set(handedOut.map(hashCode));
        expect(pending.every((row) => hashes.has(row.codeHash))).toBe(true);
      });
    });

    it('proof-pg. 20 answers with 20 distinct valid step-up proofs in parallel: one winner, ONLY its proof consumed, the losers never reach the port', async () => {
      const tickets = h.get(InteractionTicketService);
      const port = h.get(GatedStepUp);
      await rounds(async (round) => {
        const ticket = await h.get(UserInteractionService).ask(1, question({ correlationId: `proof-${round}`, freshProof: true }));
        const before = { calls: port.calls.length, consumed: port.consumed.length };
        pool.reset();
        const results = await Promise.all(Array.from({ length: 20 }, (_, i) => tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'approve', stepUpProof: `ok:${stepUpPurposeOf(ticket.id)}:${i}` }).then(() => 'won', codeOf)));
        expectParallel();
        expect(results.filter((r) => r === 'won')).toHaveLength(1);
        expect(results.filter((r) => r !== 'won').every((r) => r === 'ALREADY_ANSWERED')).toBe(true);
        expect(port.consumed.length - before.consumed).toBe(1);
        expect(port.calls.length - before.calls).toBe(1);
        await idle(h);
        expect(outcomesOf(ticket.id)).toEqual([expect.objectContaining({ status: 'answered' })]);
        expect((await rowOf(ticket.id)).dispatchStatus).toBe('done');
      });
    });

    it('F5-pg. two users registering the same own bot at once, on a pool: never both keep it, one row per bot, no orphan secret', async () => {
      const channels = h.get(InteractionChannelService);
      await rounds(async (round) => {
        const token = `72${String(round).padStart(5, '0')}:AAH-race-token-${round}-0123456789abcdef`;
        const [a, b] = [1000 + 2 * round, 1001 + 2 * round];
        h.directory.add(a);
        h.directory.add(b);
        h.telegram.addBot(token, token.split(':')[0], `race_bot_${round}`);
        pool.reset();
        const results = await Promise.all([a, b].map((id) => channels.configure(owner(id), 'telegram', { mode: 'own', token }).then(() => 'ok', codeOf)));
        expectParallel(2);
        expect([...results].sort()).toEqual(['BOT_IN_USE', 'ok']);
        expect(await h.dataSource.getRepository(InteractionUserChannelEntity).count({ where: { kind: 'telegram', externalKey: token.split(':')[0] } })).toBe(1);
        const loser = results[0] === 'ok' ? b : a;
        expect(await h.dataSource.getRepository(InteractionSecretEntity).count({ where: { ownerUserId: loser } })).toBe(0);
      });
    });

    it('F8d-pg. the last links of a bot arriving together on a pool: never more than 5 accounts per bot', async () => {
      const links = h.get(TelegramLinkService);
      const rows = h.dataSource.getRepository(InteractionTelegramLinkEntity);
      await rounds(async (round) => {
        const user = 1200 + round;
        const botRef = `u${user}`;
        for (let i = 0; i < 3; i += 1) {
          const { code } = await links.issueCode(botRef, user);
          expect(await links.consume(botRef, { telegramUserId: String(5_000_000 + round * 100 + i), chatId: String(5_000_000 + round * 100 + i), code, label: null, languageCode: null })).toBe('linked');
        }
        const codes: string[] = [];
        for (let i = 0; i < 5; i += 1) codes.push((await links.issueCode(botRef, user)).code);
        pool.reset();
        const outcomes = await Promise.all(codes.map((code, i) => links.consume(botRef, { telegramUserId: String(6_000_000 + round * 100 + i), chatId: String(6_000_000 + round * 100 + i), code, label: null, languageCode: null })));
        expectParallel(2);
        expect(outcomes.every((o) => o === 'linked' || o === 'limit')).toBe(true);
        const count = await rows.count({ where: { botRef } });
        expect(count).toBeLessThanOrEqual(5);
        expect(count).toBe(3 + outcomes.filter((o) => o === 'linked').length);
      });
    });

    it('F7-pg. 20 parallel webhook deliveries of one update on a pool: handled once; an older one arriving after it, once too', async () => {
      const store = h.get(TelegramBotStateStore);
      await rounds(async (round) => {
        const botRef = `u${1400 + round}`;
        await store.load(botRef);
        pool.reset();
        const claims = await Promise.all(Array.from({ length: 20 }, () => store.claimUpdate(botRef, 500 + round)));
        expectParallel();
        expect(claims.filter(Boolean)).toHaveLength(1);
        // An OLDER update arriving after it is still taken, once (a set of seen updates, not a monotonic offset).
        const older = await Promise.all(Array.from({ length: 5 }, () => store.claimUpdate(botRef, 499 + round)));
        expect(older.filter(Boolean)).toHaveLength(1);
        expect(await Promise.all(Array.from({ length: 3 }, () => store.claimUpdate(botRef, 500 + round)))).toEqual([false, false, false]);
      });
    });

    it('purge (Postgres queries): old deliveries, notices, closed tickets with cards and recipients, used codes and counters go; recent and open ones stay', async () => {
      await linkOwnTelegram(h, 1);
      const day = 86_400_000;
      const now = new Date();
      const old = new Date(now.getTime() - 200 * day);
      const ds = h.dataSource;
      const user = h.get(UserInteractionService);
      const closed = await user.ask(1, question({ correlationId: 'purge-closed' }));
      const open = await user.ask(1, question({ correlationId: 'purge-open' }));
      const recentClosed = await user.ask(1, question({ correlationId: 'purge-recent' }));
      await idle(h);
      const tickets = h.get(InteractionTicketService);
      await tickets.answer({ ticketId: closed.id, userId: 1, via: 'inapp', actionId: 'approve' });
      await tickets.answer({ ticketId: recentClosed.id, userId: 1, via: 'inapp', actionId: 'approve' });
      await idle(h);
      await ds.query(`UPDATE ${table('interaction_ticket')} SET "updated_at" = $1 WHERE "id" = $2`, [old, closed.id]);
      await ds.query(`UPDATE ${table('interaction_notice')} SET "created_at" = $1 WHERE "ticket_id" = $2`, [old, closed.id]);
      await ds.query(`UPDATE ${table('interaction_delivery')} SET "created_at" = $1 WHERE "ticket_id" = $2`, [old, closed.id]);
      const codes = h.get(TelegramLinkService);
      const fresh = await codes.issueCode('u1', 1);
      expect(fresh.code).toBeTruthy();
      // The code that linked the Telegram account (used) expired 2 days ago; the fresh one is still valid.
      await ds.getRepository(InteractionLinkCodeEntity).update({ usedAt: Not(IsNull()) }, { expiresAt: new Date(now.getTime() - 2 * day) });
      const sends = ds.getRepository(InteractionSendCounterEntity);
      await sends.insert({ kind: 'channel_test', userId: 1, ip: null, targetHash: null, at: new Date(now.getTime() - 3 * day) });
      await sends.insert({ kind: 'channel_test', userId: 1, ip: null, targetHash: null, at: new Date(now.getTime() - 1 * day) });
      const counts = async () => ({
        tickets: await ds.getRepository(InteractionTicketEntity).count(),
        cards: await ds.getRepository(InteractionTicketCardEntity).count({ where: { ticketId: closed.id } }),
        recipients: await ds.getRepository(InteractionTicketRecipientEntity).count({ where: { ticketId: closed.id } }),
        notices: await ds.getRepository(InteractionNoticeEntity).count({ where: { ticketId: closed.id } }),
        deliveries: await ds.query(`SELECT count(*)::int AS n FROM ${table('interaction_delivery')} WHERE "ticket_id" = $1`, [closed.id]).then((r: Array<{ n: number }>) => r[0].n),
        sends: await sends.count(),
        codes: await ds.getRepository(InteractionLinkCodeEntity).count(),
      });
      const before = await counts();
      expect(before).toMatchObject({ tickets: 3, sends: 3, codes: 2 });
      expect(before.cards).toBeGreaterThan(0);
      expect(before.recipients).toBe(1);
      expect(before.notices).toBeGreaterThan(0);
      expect(before.deliveries).toBeGreaterThan(0);
      pool.reset();
      await Promise.all([h.get(InteractionMaintenanceService).purge(now), h.get(InteractionMaintenanceService).purge(now)]);
      expect(await counts()).toEqual({ tickets: 2, cards: 0, recipients: 0, notices: 0, deliveries: 0, sends: 2, codes: 1 });
      expect((await rowOf(open.id)).status).toBe('open');
      expect((await rowOf(recentClosed.id)).status).toBe('answered');
    });

    it('column types: timestamps keep the millisecond and the instant, jsonb round-trips, integers stay numbers', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000 + 123);
      const ticket = await h.get(UserInteractionService).ask(1, question({ correlationId: 'types', expiresAt, summary: { title: { raw: 'Ünï « 日本 » ✓' }, body: { raw: "it's \"quoted\" \\ back" }, fields: [{ label: { raw: 'k' }, value: 'v' }] } }));
      const row = await rowOf(ticket.id);
      expect(row.expiresAt).toBeInstanceOf(Date);
      expect(row.expiresAt.getTime()).toBe(expiresAt.getTime());
      expect(row.summary).toEqual({ title: { raw: 'Ünï « 日本 » ✓' }, body: { raw: "it's \"quoted\" \\ back" }, fields: [{ label: { raw: 'k' }, value: 'v' }] });
      expect(row.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(typeof row.dispatchAttempts).toBe('number');
      expect(row.actions.map((a) => a.id)).toEqual(['approve', 'deny']);
      const [meta] = await h.dataSource.query(`SELECT pg_typeof("summary")::text AS summary, pg_typeof("expires_at")::text AS expires, pg_typeof("dispatch_attempts")::text AS attempts, pg_typeof("id")::text AS id FROM ${table('interaction_ticket')} WHERE "id" = $1`, [ticket.id]);
      expect(meta).toEqual({ summary: 'jsonb', expires: 'timestamp with time zone', attempts: 'integer', id: 'uuid' });
      // The server clock and the Node clock agree on the instant (no session time zone shift).
      const [{ shift }] = await h.dataSource.query(`SELECT extract(epoch FROM ("expires_at" - $1::timestamptz))::float AS shift FROM ${table('interaction_ticket')} WHERE "id" = $2`, [ticket.expiresAt, ticket.id]);
      expect(shift).toBe(0);
    });
  });
}
