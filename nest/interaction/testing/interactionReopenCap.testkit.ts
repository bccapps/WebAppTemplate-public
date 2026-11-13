/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Library gaps found by the reviews of the C3 adoption (TradeKong) and of AgentHub (step 5.8), run on SQLite AND Postgres:
// - `reopen(source, correlationId)`: a ticket cancelled while its question was still pending is opened again by a conditional
//   UPDATE (cancelled → open, never answered, never expired normally), its recipients notified again, idempotent, audited;
// - the module is an account erasure participant (`common/types/ExtensionPoints.ts`): `user` finds it at closure and it forgets the account;
// - a `critical` notice is exempt from the hourly caps (per user and global), not from the deduplication nor from the absolute
//   ceiling `CRITICAL_MAX_PER_USER_HOUR`.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { ACCOUNT_ERASURE_PARTICIPANT, type AccountErasureParticipant } from '../../common/types/ExtensionPoints';
import { InteractionUserChannelEntity } from '../entities/InteractionUserChannelEntity';
import { InteractionAccountErasure } from '../services/InteractionAccountErasure';
import { InteractionDeliveryEntity } from '../entities/InteractionDeliveryEntity';
import { InteractionTicketEntity } from '../entities/InteractionTicketEntity';
import { InteractionChannelService } from '../services/InteractionChannelService';
import { CRITICAL_MAX_PER_USER_HOUR } from '../services/InteractionDeliveryService';
import { InteractionInboxService } from '../services/InteractionInboxService';
import { InteractionTicketService } from '../services/InteractionTicketService';
import { UserInteractionService } from '../services/UserInteractionService';
import { expectCode, idle, linkOwnTelegram, notice, owner, question, subscribeBrowser } from './interactionConformance.testkit';
import { createInteractionHarness, type Harness, type HarnessDatabase } from './interactionHarness';

export interface ReopenCapOptions {
  database: () => HarnessDatabase;
}

export function describeInteractionReopenAndCap(label: string, options: ReopenCapOptions): void {
  describe(`interaction reopen and critical cap — ${label}`, () => {
    let h: Harness;
    let handled: Array<{ ticketId: string; status: string; actionId: string | null }>;

    beforeEach(async () => {
      h = await createInteractionHarness({ database: options.database(), config: { interaction_enabledKinds: ['browser', 'telegram'], interaction_providerTimeoutMs: 1000 } });
      for (const id of [1, 2, 3]) h.directory.add(id);
      h.directory.add(9, { admin: true });
      handled = [];
      h.get(UserInteractionService).onAnswer('test.approval', async (answer) => void handled.push({ ticketId: answer.ticketId, status: answer.status, actionId: answer.actionId }));
    });

    afterEach(async () => {
      await idle(h).catch(() => undefined);
      await h.close();
    });

    const ticketRow = (id: string) => h.dataSource.getRepository(InteractionTicketEntity).findOneByOrFail({ id });
    const reopenAudits = () => h.logs.filter((line) => line.includes('ticket.reopen '));
    const cardsSent = () => h.telegram.sent().filter((call) => call.keyboard?.inline_keyboard.some((row) => row.some((button) => 'callback_data' in button))).length;

    // -------------------------------------------------------------------------
    // reopen
    // -------------------------------------------------------------------------

    it('R1. a cancelled, unanswered ticket is reopened: open again, back in the inbox, recipients notified again, answerable', async () => {
      const service = h.get(UserInteractionService);
      await linkOwnTelegram(h, 1);
      await subscribeBrowser(h, 1);
      const q = question();
      const asked = await service.ask(1, q);
      await idle(h);
      expect(cardsSent()).toBe(1);
      expect(h.push.sent).toHaveLength(1);
      expect(await service.cancel(q.source, q.correlationId, 'resolved')).toBe(true);
      await idle(h);
      expect(handled).toEqual([{ ticketId: asked.id, status: 'cancelled', actionId: null }]);
      // What AgentHub saw (review I-3): ask() of the same correlation finds the cancelled ticket and returns it as is.
      expect((await service.ask(1, q)).status).toBe('cancelled');
      expect((await h.get(InteractionInboxService).inbox(1)).tickets).toHaveLength(0);

      const result = await service.reopen(q.source, q.correlationId);
      expect(result.outcome).toBe('reopened');
      expect(result.ticket).toMatchObject({ id: asked.id, status: 'open', recipients: [1] });
      expect(result.ticket?.deliveries[0]?.deliveries[0]).toEqual({ kind: 'inapp', status: 'sent', code: null });
      await idle(h);
      const row = await ticketRow(asked.id);
      expect([row.status, row.cancelReason, row.dispatchStatus, row.dispatchAttempts, row.answerAction]).toEqual(['open', null, 'none', 0, null]);
      expect((await h.get(InteractionInboxService).inbox(1)).tickets.map((t) => t.id)).toEqual([asked.id]);
      expect(cardsSent()).toBe(2);
      expect(h.push.sent).toHaveLength(2);
      expect(reopenAudits()).toHaveLength(1);
      expect(reopenAudits()[0]).toContain(`ticket=${asked.id}`);
      // Answerable again; the answer reaches the handler (the earlier cancelled hand-over is not replayed).
      await h.get(InteractionTicketService).answer({ ticketId: asked.id, userId: 1, via: 'inapp', actionId: 'approve' });
      await idle(h);
      expect(handled.map((a) => a.status)).toEqual(['cancelled', 'answered']);
      expect((await ticketRow(asked.id)).status).toBe('answered');
    });

    it('R2. idempotent: a second reopen (and five concurrent ones) changes nothing and notifies nobody again', async () => {
      const service = h.get(UserInteractionService);
      await linkOwnTelegram(h, 1);
      const q = question();
      await service.ask(1, q);
      await idle(h);
      await service.cancel(q.source, q.correlationId, 'resolved');
      await idle(h);
      const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => service.reopen(q.source, q.correlationId)));
      expect(outcomes.filter((o) => o.outcome === 'reopened')).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === 'already_open')).toHaveLength(4);
      await idle(h);
      expect(cardsSent()).toBe(2);
      expect((await service.reopen(q.source, q.correlationId)).outcome).toBe('already_open');
      await idle(h);
      expect(cardsSent()).toBe(2);
      expect(reopenAudits()).toHaveLength(1);
    });

    it('R3. never reopens an answered ticket, nor one expired normally, nor a cancelled one past its expiry without a new one', async () => {
      const service = h.get(UserInteractionService);
      const tickets = h.get(InteractionTicketService);
      const answered = question();
      const a = await service.ask(1, answered);
      await tickets.answer({ ticketId: a.id, userId: 1, via: 'inapp', actionId: 'deny' });
      await idle(h);
      expect((await service.reopen(answered.source, answered.correlationId)).outcome).toBe('answered');
      expect((await ticketRow(a.id)).status).toBe('answered');

      const expiring = question();
      const e = await service.ask(1, expiring);
      await h.dataSource.getRepository(InteractionTicketEntity).update({ id: e.id }, { expiresAt: new Date(Date.now() - 1000) });
      expect(await tickets.expireDue()).toBe(1);
      await idle(h);
      expect((await service.reopen(expiring.source, expiring.correlationId)).outcome).toBe('expired');
      expect((await service.reopen(expiring.source, expiring.correlationId, { expiresAt: new Date(Date.now() + 60_000) })).outcome).toBe('expired');
      expect((await ticketRow(e.id)).status).toBe('expired');

      // Cancelled, then its expiry passed: only a new expiry (within the max TTL) reopens it.
      const late = question();
      const l = await service.ask(1, late);
      await service.cancel(late.source, late.correlationId, 'resolved');
      await idle(h);
      await h.dataSource.getRepository(InteractionTicketEntity).update({ id: l.id }, { expiresAt: new Date(Date.now() - 1000) });
      expect((await service.reopen(late.source, late.correlationId)).outcome).toBe('expired');
      await expectCode(service.reopen(late.source, late.correlationId, { expiresAt: new Date(Date.now() + 30 * 86_400_000) }), 'INVALID_QUESTION');
      await expectCode(service.reopen(late.source, late.correlationId, { expiresAt: new Date(Date.now() - 1) }), 'INVALID_QUESTION');
      expect((await ticketRow(l.id)).status).toBe('cancelled');
      const until = new Date(Date.now() + 60_000);
      const reopened = await service.reopen(late.source, late.correlationId, { expiresAt: until });
      expect(reopened.outcome).toBe('reopened');
      expect((await ticketRow(l.id)).expiresAt.getTime()).toBe(until.getTime());
    });

    it('R4. unknown ticket, nobody left to ask, a hand-over of the cancellation still pending: refused, ticket unchanged', async () => {
      const service = h.get(UserInteractionService);
      expect((await service.reopen('tests', 'never-asked')).outcome).toBe('not_found');
      expect((await service.reopen('NOT A SOURCE', 'x')).outcome).toBe('not_found');

      // The only recipient was withdrawn (C2): the ticket was cancelled with nobody left.
      const revoked = question();
      const r = await service.ask(1, revoked);
      await service.revokeRecipient(revoked.source, revoked.correlationId, 1, 'lost_access');
      await idle(h);
      expect((await service.reopen(revoked.source, revoked.correlationId)).outcome).toBe('no_recipient');
      expect((await ticketRow(r.id)).status).toBe('cancelled');

      // Every recipient deactivated since.
      const inactive = question();
      const i = await service.ask([1, 2], inactive);
      await service.cancel(inactive.source, inactive.correlationId, 'resolved');
      await idle(h);
      h.directory.users.get(1)!.active = false;
      h.directory.users.get(2)!.active = false;
      expect((await service.reopen(inactive.source, inactive.correlationId)).outcome).toBe('no_recipient');
      expect((await ticketRow(i.id)).status).toBe('cancelled');
      h.directory.users.get(2)!.active = true;
      const back = await service.reopen(inactive.source, inactive.correlationId);
      expect(back.outcome).toBe('reopened');
      // Only the active recipient is notified again; the inactive one stays a recipient (an answer from them is refused anyway).
      expect(back.ticket?.deliveries.map((d) => d.userId)).toEqual([2]);
      h.directory.users.get(1)!.active = true;

      // The cancellation's hand-over is still pending (being given to the handler, or waiting for a retry): `busy`, nothing changed.
      const pending = question();
      const p = await service.ask(1, pending);
      await service.cancel(pending.source, pending.correlationId, 'resolved');
      await idle(h);
      const repo = h.dataSource.getRepository(InteractionTicketEntity);
      await repo.update({ id: p.id }, { dispatchStatus: 'pending', dispatchNextAt: new Date(Date.now() + 60_000) });
      expect((await service.reopen(pending.source, pending.correlationId)).outcome).toBe('busy');
      expect([(await ticketRow(p.id)).status, (await ticketRow(p.id)).dispatchStatus]).toEqual(['cancelled', 'pending']);
      await repo.update({ id: p.id }, { dispatchStatus: 'failed', dispatchNextAt: null });
      expect((await service.reopen(pending.source, pending.correlationId)).outcome).toBe('reopened');
    });

    it('R5. the notification follows the preferences: a channel switched off gets nothing, inapp always', async () => {
      const service = h.get(UserInteractionService);
      await linkOwnTelegram(h, 1);
      await subscribeBrowser(h, 1);
      const q = question();
      await service.ask(1, q);
      await service.cancel(q.source, q.correlationId, 'resolved');
      await idle(h);
      await h.get(InteractionChannelService).setState(owner(1), 'telegram', { enabled: false });
      const result = await service.reopen(q.source, q.correlationId);
      await idle(h);
      const kinds = result.ticket?.deliveries[0]?.deliveries ?? [];
      expect(kinds[0]).toEqual({ kind: 'inapp', status: 'sent', code: null });
      expect(kinds.find((d) => d.kind === 'telegram')?.status).not.toBe('queued');
      expect(cardsSent()).toBe(1);
      expect(h.push.sent).toHaveLength(2);
    });

    // -------------------------------------------------------------------------
    // critical notices and the hourly caps
    // -------------------------------------------------------------------------

    it('C1. a critical notice passes the per-user cap (browser and Telegram), a normal one is still capped; inapp always', async () => {
      const service = h.get(UserInteractionService);
      await linkOwnTelegram(h, 1);
      await subscribeBrowser(h, 1);
      h.config.values.set('interaction_maxPerUserHour', 1);
      await service.notify(1, notice({ category: 'security' }));
      const capped = await service.notify(1, notice({ category: 'security' }));
      expect(capped.deliveries.find((d) => d.kind === 'telegram')).toEqual({ kind: 'telegram', status: 'skipped', code: 'CAPPED' });
      const critical = await service.notify(1, notice({ category: 'security', priority: 'critical', type: 'tests.emergency_stop' }));
      expect(critical.deliveries[0]).toEqual({ kind: 'inapp', status: 'sent', code: null });
      expect(critical.deliveries.find((d) => d.kind === 'telegram')).toEqual({ kind: 'telegram', status: 'sent', code: null });
      expect(critical.deliveries.find((d) => d.kind === 'browser')).toEqual({ kind: 'browser', status: 'sent', code: null });
      const criticalInfo = await service.notify(1, notice({ priority: 'critical' }));
      expect(criticalInfo.deliveries.find((d) => d.kind === 'telegram')?.status).toBe('sent');
      const normalAfter = await service.notify(1, notice({ category: 'security' }));
      expect(normalAfter.deliveries.find((d) => d.kind === 'telegram')?.code).toBe('CAPPED');
    });

    it('C2. a critical notice passes the global cap too', async () => {
      const service = h.get(UserInteractionService);
      await linkOwnTelegram(h, 1);
      h.config.values.set('interaction_maxExternalPerHour', 1);
      await service.notify(1, notice({ category: 'security' }));
      expect((await service.notify(1, notice({ category: 'security' }))).deliveries.find((d) => d.kind === 'telegram')?.code).toBe('CAPPED');
      expect((await service.notify(1, notice({ category: 'security', priority: 'critical' }))).deliveries.find((d) => d.kind === 'telegram')?.status).toBe('sent');
    });

    it('C3. a critical notice is still deduplicated, and stopped by the absolute ceiling (a loop)', async () => {
      const service = h.get(UserInteractionService);
      await linkOwnTelegram(h, 1);
      h.config.values.set('interaction_maxPerUserHour', 0);
      const first = await service.notify(1, notice({ category: 'security', priority: 'critical', dedupKey: 'stop-1' }));
      expect(first.deliveries.find((d) => d.kind === 'telegram')?.status).toBe('sent');
      const again = await service.notify(1, notice({ category: 'security', priority: 'critical', dedupKey: 'stop-1' }));
      expect(again.deliveries.every((d) => d.status === 'duplicate')).toBe(true);
      expect(CRITICAL_MAX_PER_USER_HOUR).toBe(60);
      // The user already got the ceiling's worth of external deliveries this hour (whatever their category): capped.
      const rows = h.dataSource.getRepository(InteractionDeliveryEntity);
      const filler = Array.from({ length: CRITICAL_MAX_PER_USER_HOUR }, () => ({ id: randomUUID(), userId: 1, dedupKey: `r:${randomUUID()}`, kind: 'telegram', category: 'info', type: 'tests.filler', ticketId: null, status: 'sent', code: null, sentAt: new Date() }));
      await rows.insert(filler);
      const looping = await service.notify(1, notice({ category: 'security', priority: 'critical' }));
      expect(looping.deliveries[0]).toEqual({ kind: 'inapp', status: 'sent', code: null });
      expect(looping.deliveries.find((d) => d.kind === 'telegram')).toEqual({ kind: 'telegram', status: 'skipped', code: 'CAPPED' });
      // Another user is not affected by user 1's ceiling.
      await linkOwnTelegram(h, 2, '7000002:AAH-test-token-of-user-two-0123456789', '777000456');
      expect((await service.notify(2, notice({ category: 'security', priority: 'critical' }))).deliveries.find((d) => d.kind === 'telegram')?.status).toBe('sent');
    });

    // -------------------------------------------------------------------------
    // account erasure participant
    // -------------------------------------------------------------------------

    it('E1. an account erasure participant, found by discovery: forgets the account (lone tickets cancelled), idempotent', async () => {
      const service = h.get(UserInteractionService);
      expect(Reflect.getMetadata(ACCOUNT_ERASURE_PARTICIPANT, InteractionAccountErasure)).toBe(true);
      // What `user` does at closure (`AccountErasureParticipants`): discovery of the marked singleton providers.
      const found = new DiscoveryService(h.module.get(ModulesContainer))
        .getProviders()
        .filter((wrapper) => wrapper.metatype && Reflect.getMetadata(ACCOUNT_ERASURE_PARTICIPANT, wrapper.metatype) === true)
        .map((wrapper) => wrapper.instance as AccountErasureParticipant);
      expect(found.map((p) => p.erasureKey)).toEqual(['interaction']);
      await linkOwnTelegram(h, 1);
      const lone = question();
      const shared = question();
      const loneTicket = await service.ask(1, lone);
      const sharedTicket = await service.ask([1, 2], shared);
      await idle(h);
      h.directory.users.get(1)!.active = false;
      await found[0].onAccountErased?.(1);
      await idle(h);
      expect((await ticketRow(loneTicket.id)).status).toBe('cancelled');
      expect((await ticketRow(loneTicket.id)).cancelReason).toBe('user_deleted');
      expect((await ticketRow(sharedTicket.id)).status).toBe('open');
      expect(await h.dataSource.getRepository(InteractionUserChannelEntity).countBy({ userId: 1 })).toBe(0);
      await expect(found[0].onAccountErased?.(1)).resolves.toBeUndefined();
      expect(h.get(InteractionAccountErasure)).toBe(found[0]);
    });
  });
}
