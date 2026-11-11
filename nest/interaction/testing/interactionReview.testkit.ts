/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Regression suite of the independent review of lot C1 (findings F1-F9), run on SQLite AND Postgres. Each test is the
// reviewer's exploit with its assertion turned around: it failed on the code before the fix. The Postgres pool variants
// (two users racing for one bot, parallel links, parallel webhook deliveries) are in `interactionConcurrency.testkit.ts`.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { QueryFailedError, IsNull } from 'typeorm';
import { InteractionSecretEntity } from '../entities/InteractionSecretEntity';
import { InteractionTelegramUpdateEntity } from '../entities/InteractionTelegramUpdateEntity';
import { InteractionTelegramLinkEntity } from '../entities/InteractionTelegramLinkEntity';
import { InteractionTicketEntity } from '../entities/InteractionTicketEntity';
import { InteractionUserChannelEntity } from '../entities/InteractionUserChannelEntity';
import { InteractionWebPushSubscriptionEntity } from '../entities/InteractionWebPushSubscriptionEntity';
import { InteractionNoticeEntity } from '../entities/InteractionNoticeEntity';
import { isInteractionError } from '../errors/InteractionError';
import { BrowserChannelProvider } from '../providers/browser/BrowserChannelProvider';
import { TelegramBotStateStore } from '../providers/telegram/TelegramBotStateStore';
import { TelegramChannelProvider } from '../providers/telegram/TelegramChannelProvider';
import { TelegramInboundRegistry } from '../providers/telegram/TelegramInboundRegistry';
import { TelegramLinkService } from '../providers/telegram/TelegramLinkService';
import { TelegramUpdateHandler } from '../providers/telegram/TelegramUpdateHandler';
import { InteractionChannelService } from '../services/InteractionChannelService';
import { InteractionKeyService } from '../services/InteractionKeyService';
import { InteractionTicketService } from '../services/InteractionTicketService';
import { UserInteractionService } from '../services/UserInteractionService';
import type { InteractionAnswer } from '../types/interactionTypes';
import { INTERACTION_SECRET_STORE, stepUpPurposeOf, type InteractionSecretStore } from '../types/ports';
import type { InteractionChannelProvider } from '../types/providerTypes';
import { BOT_TOKEN, BOT_TOKEN_2, ENDPOINT, http, idle, lastCard, linkOwnTelegram, owner, pressUpdate, question, startUpdate, subscribeBrowser, TG_ACCOUNT } from './interactionConformance.testkit';
import { GatedStepUp, InAppReplyProvider } from './interactionHardening.testkit';
import { createInteractionHarness, type Harness, type HarnessDatabase, type HarnessOptions } from './interactionHarness';

export interface ReviewOptions {
  database: () => HarnessDatabase;
}

const OP_TOKEN = '7000009:AAH-operator-token-0123456789abcdefgh';
const codeOf = (error: unknown): string => (isInteractionError(error) ? error.code : `raw:${(error as Error)?.message ?? String(error)}`);
const keys = { p256dh: 'BPk' + 'a'.repeat(80), auth: 'auth' + 'b'.repeat(18) };
const message = (updateId: number, text: string, account = TG_ACCOUNT, date = Math.floor(Date.now() / 1000)) => ({ update_id: updateId, message: { message_id: updateId, date, chat: { id: Number(account), type: 'private' }, from: { id: Number(account), is_bot: false }, text } });

export function describeInteractionReview(label: string, options: ReviewOptions): void {
  describe(`interaction review findings F1-F9 — ${label}`, () => {
    let h: Harness;
    let handled: InteractionAnswer[];

    async function make(config: Record<string, unknown> = {}, extra: Partial<HarnessOptions> = {}): Promise<Harness> {
      const created = await createInteractionHarness({ database: options.database(), config: { interaction_enabledKinds: ['browser', 'telegram', 'hubchat'], interaction_providerTimeoutMs: 1000, ...config }, providers: [InAppReplyProvider], stepUp: GatedStepUp, ...extra });
      for (const id of [1, 2, 3]) created.directory.add(id);
      created.directory.add(9, { admin: true });
      handled = [];
      created.get(UserInteractionService).onAnswer('test.approval', async (answer) => void handled.push(answer));
      return created;
    }

    afterEach(async () => {
      jest.restoreAllMocks();
      await idle(h).catch(() => undefined);
      await h.close();
    });

    async function linkOperator(userId: number, account = TG_ACCOUNT, update = 1): Promise<void> {
      h.config.secrets.set('interaction_telegramOperatorBotToken', OP_TOKEN);
      h.telegram.addBot(OP_TOKEN, OP_TOKEN.split(':')[0], 'operator_bot');
      await h.get(InteractionChannelService).configure(owner(userId), 'telegram', { mode: 'operator' });
      const { code } = await h.get(TelegramChannelProvider).linkCode(owner(userId));
      await h.get(TelegramUpdateHandler).handle('telegram', OP_TOKEN, startUpdate(update, account, code));
    }

    const ticketRow = (id: string) => h.dataSource.getRepository(InteractionTicketEntity).findOneByOrFail({ id });

    // -------------------------------------------------------------------------
    // F1: a user API token is no human session
    // -------------------------------------------------------------------------

    it('F1 / S6. /me routes fail CLOSED: an API token, and a user principal WITHOUT the human-session marker, are refused like no session', async () => {
      h = await make();
      const strip = (body: Record<string, unknown>) => ({ code: body.code, message: body.message, statusCode: body.statusCode });
      for (const [method, path] of [['get', '/api/v1/interaction/me/channels'], ['get', '/api/v1/interaction/me/inbox'], ['post', '/api/v1/interaction/me/channels/telegram/link-code'], ['put', '/api/v1/interaction/me/channels/browser']] as const) {
        const none = await http(h)[method](path);
        for (const token of ['api-user-1', 'bare-user-1']) {
          const res = await http(h)[method](path).set('Authorization', `Bearer ${token}`);
          expect([token, res.status, strip(res.body)]).toEqual([token, 401, strip(none.body)]);
        }
      }
      expect((await http(h).get('/api/v1/interaction/me/channels').set('Authorization', 'Bearer user-1')).status).toBe(200);
    });

    // -------------------------------------------------------------------------
    // F2: the owner's and the administrator's switches stop Telegram answers, in operator mode too
    // -------------------------------------------------------------------------

    it('F2a. operator mode: a card sent before the administrator disabled the channel can no longer answer', async () => {
      h = await make({ interaction_telegramMode: 'operator' });
      await linkOperator(1);
      const ticket = await h.get(UserInteractionService).ask(1, question());
      await idle(h);
      const card = lastCard(h);
      await h.get(InteractionChannelService).adminSetDisabled({ userId: 9 }, 1, 'telegram', true);
      await h.get(TelegramUpdateHandler).handle('telegram', OP_TOKEN, pressUpdate(2, { account: TG_ACCOUNT, chatId: TG_ACCOUNT, messageId: card.messageId, data: card.data[0] }));
      await idle(h);
      expect((await ticketRow(ticket.id)).status).toBe('open');
      expect(handled).toEqual([]);
      expect(h.telegram.calls.filter((c) => c.method === 'answerCallbackQuery').pop()?.text).toBe('This button is no longer active.');
      // The service refuses the channel itself as well (any non-inapp `via`).
      await expect(h.get(InteractionTicketService).answer({ ticketId: ticket.id, userId: 1, via: 'telegram', actionId: 'approve' })).rejects.toMatchObject({ code: 'ADMIN_DISABLED' });
    });

    it('F2b. operator mode: the owner switching the channel off stops card answers at once (and on again restores them)', async () => {
      h = await make({ interaction_telegramMode: 'operator' });
      await linkOperator(1);
      const ticket = await h.get(UserInteractionService).ask(1, question());
      await idle(h);
      const card = lastCard(h);
      await h.get(InteractionChannelService).setState(owner(1), 'telegram', { enabled: false });
      await h.get(TelegramUpdateHandler).handle('telegram', OP_TOKEN, pressUpdate(2, { account: TG_ACCOUNT, chatId: TG_ACCOUNT, messageId: card.messageId, data: card.data[1] }));
      expect((await ticketRow(ticket.id)).status).toBe('open');
      await expect(h.get(InteractionTicketService).answer({ ticketId: ticket.id, userId: 1, via: 'telegram', actionId: 'deny' })).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
      await h.get(InteractionChannelService).setState(owner(1), 'telegram', { enabled: true });
      await h.get(TelegramUpdateHandler).handle('telegram', OP_TOKEN, pressUpdate(3, { account: TG_ACCOUNT, chatId: TG_ACCOUNT, messageId: card.messageId, data: card.data[1] }));
      expect((await ticketRow(ticket.id)).status).toBe('answered');
    });

    it('F2c. app message / button handlers run only for an active user with an enabled, non-disabled, /start-linked channel of this bot', async () => {
      h = await make({ interaction_telegramMode: 'both' });
      await linkOperator(1);
      const seen: string[] = [];
      h.get(TelegramInboundRegistry).setMessageHandler(async (_message, ctx) => void seen.push(`message:${ctx.userId}`));
      h.get(TelegramInboundRegistry).addCallbackFamily('dc:', async (_press, ctx) => {
        seen.push(`press:${ctx.userId}`);
        return null;
      });
      const handler = h.get(TelegramUpdateHandler);
      let update = 10;
      const probe = async (): Promise<string[]> => {
        seen.length = 0;
        await handler.handle('telegram', OP_TOKEN, message((update += 1), 'transfer everything'));
        await handler.handle('telegram', OP_TOKEN, pressUpdate((update += 1), { account: TG_ACCOUNT, chatId: TG_ACCOUNT, messageId: '5', data: 'dc:anything' }));
        return [...seen];
      };
      expect(await probe()).toEqual(['message:1', 'press:1']);
      const channels = h.get(InteractionChannelService);
      const rows = h.dataSource.getRepository(InteractionUserChannelEntity);
      const links = h.dataSource.getRepository(InteractionTelegramLinkEntity);
      await channels.adminSetDisabled({ userId: 9 }, 1, 'telegram', true);
      expect(await probe()).toEqual([]);
      await channels.adminSetDisabled({ userId: 9 }, 1, 'telegram', false);
      await channels.setState(owner(1), 'telegram', { enabled: false });
      expect(await probe()).toEqual([]);
      await channels.setState(owner(1), 'telegram', { enabled: true });
      h.directory.users.get(1)!.active = false;
      expect(await probe()).toEqual([]);
      h.directory.users.get(1)!.active = true;
      await links.update({ botRef: 'telegram' }, { source: 'legacy' });
      expect(await probe()).toEqual([]);
      await links.update({ botRef: 'telegram' }, { source: 'code' });
      // A link of the operator's bot while the channel is in `own` mode (inconsistent data): ignored.
      const row = await rows.findOneByOrFail({ userId: 1, kind: 'telegram' });
      await rows.update({ id: row.id }, { config: { ...row.config, mode: 'own' } as never });
      expect(await probe()).toEqual([]);
      await rows.update({ id: row.id }, { config: row.config as never });
      expect(await probe()).toEqual(['message:1', 'press:1']);
    });

    // -------------------------------------------------------------------------
    // F3: answer handlers bound to their source
    // -------------------------------------------------------------------------

    it('F3. a kind bound to a source refuses an ask of another source, and never hands it a stored ticket of another source', async () => {
      h = await make();
      const api = h.get(UserInteractionService);
      const outcomes: InteractionAnswer[] = [];
      const unbind = api.onAnswer('mcp.approval', async (answer) => void outcomes.push(answer));
      // Before the binding (or for an unbound kind) any source may ask: the handler sees `answer.source`.
      const decoy = await api.ask(1, question({ kind: 'mcp.approval', source: 'other-module', correlationId: 'approval-123', summary: { title: { raw: 'Mark as read?' } } }));
      unbind();
      api.onAnswer('mcp.approval', async (answer) => void outcomes.push(answer), { source: 'mcp-access' });
      await expect(api.ask(1, question({ kind: 'mcp.approval', source: 'other-module', correlationId: 'approval-456' }))).rejects.toMatchObject({ code: 'INVALID_QUESTION', details: { field: 'source' } });
      const real = await api.ask(1, question({ kind: 'mcp.approval', source: 'mcp-access', correlationId: 'approval-123' }));
      expect(real.id).not.toBe(decoy.id);
      await h.get(InteractionTicketService).answer({ ticketId: decoy.id, userId: 1, via: 'inapp', actionId: 'approve' });
      await h.get(InteractionTicketService).answer({ ticketId: real.id, userId: 1, via: 'inapp', actionId: 'deny' });
      await idle(h);
      expect(outcomes).toEqual([expect.objectContaining({ ticketId: real.id, source: 'mcp-access', actionId: 'deny' })]);
      expect((await ticketRow(decoy.id)).dispatchStatus).toBe('failed');
      expect(() => api.onAnswer('bad.bind', async () => undefined, { source: 'Not A Source!' })).toThrow(/invalid source/);
    });

    // -------------------------------------------------------------------------
    // F4: never answered after expires_at
    // -------------------------------------------------------------------------

    it('F4. a step-up check that outlasts expires_at is EXPIRED, and the handler only ever receives « expired »', async () => {
      h = await make();
      const port = h.get(GatedStepUp);
      port.delayMs = 1500;
      const expiresAt = new Date(Date.now() + 600);
      const ticket = await h.get(UserInteractionService).ask(1, question({ freshProof: true, expiresAt }));
      const tickets = h.get(InteractionTicketService);
      const result = await tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'approve', stepUpProof: `ok:${stepUpPurposeOf(ticket.id)}:slow` }).then(() => 'won', codeOf);
      expect(Date.now()).toBeGreaterThan(expiresAt.getTime());
      expect(result).toBe('EXPIRED');
      expect((await ticketRow(ticket.id)).status).toBe('open');
      expect(await tickets.expireDue()).toBe(1);
      await idle(h);
      expect(handled).toEqual([expect.objectContaining({ ticketId: ticket.id, status: 'expired', actionId: null })]);
    }, 15_000);

    it('F4b. an answer waiting for another one’s claim past expires_at is EXPIRED too', async () => {
      h = await make();
      const port = h.get(GatedStepUp);
      port.delayMs = 1200;
      const expiresAt = new Date(Date.now() + 500);
      const ticket = await h.get(UserInteractionService).ask(1, question({ freshProof: true, expiresAt }));
      const tickets = h.get(InteractionTicketService);
      const bad = tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'deny', stepUpProof: 'garbage' }).then(() => 'won', codeOf);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const good = tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'approve', stepUpProof: `ok:${stepUpPurposeOf(ticket.id)}:good` }).then(() => 'won', codeOf);
      expect(await bad).toBe('STEP_UP_REQUIRED');
      expect(await good).toBe('EXPIRED');
      await idle(h);
      expect(handled.filter((answer) => answer.status === 'answered')).toEqual([]);
    }, 15_000);

    // -------------------------------------------------------------------------
    // F5: one bot, one user
    // -------------------------------------------------------------------------

    it('F5. two users registering the SAME bot at the same instant: one keeps it, the other gets BOT_IN_USE and keeps no secret', async () => {
      h = await make();
      h.telegram.addBot(BOT_TOKEN, BOT_TOKEN.split(':')[0], 'shared_bot');
      const channels = h.get(InteractionChannelService);
      const results = await Promise.all([1, 2].map((id) => channels.configure(owner(id), 'telegram', { mode: 'own', token: BOT_TOKEN }).then(() => 'ok', codeOf)));
      expect([...results].sort()).toEqual(['BOT_IN_USE', 'ok']);
      const rows = await h.dataSource.getRepository(InteractionUserChannelEntity).find({ where: { kind: 'telegram', externalKey: BOT_TOKEN.split(':')[0] } });
      expect(rows).toHaveLength(1);
      const loser = results[0] === 'ok' ? 2 : 1;
      expect(await h.dataSource.getRepository(InteractionSecretEntity).count({ where: { ownerUserId: loser } })).toBe(0);
    });

    // -------------------------------------------------------------------------
    // F6: no database message nor parameter out of the module
    // -------------------------------------------------------------------------

    it('F6a. web push keys longer than their column (258 with padding) are refused 400, never a 500; 256 fits', async () => {
      h = await make();
      const post = (p256dh: string, auth: string) => http(h).post('/api/v1/interaction/me/webpush/subscriptions').set('Authorization', 'Bearer user-1').send({ endpoint: `${ENDPOINT}-${p256dh.length}-${auth.length}`, keys: { p256dh, auth } });
      for (const [p256dh, auth] of [['a'.repeat(256) + '==', 'b'.repeat(22)], ['a'.repeat(87), 'b'.repeat(255) + '=='], ['a'.repeat(257), 'b'.repeat(22)]]) {
        const res = await post(p256dh, auth);
        expect([res.status, res.body.code, res.body.details?.field]).toEqual([400, 'INVALID_INPUT', 'keys']);
      }
      expect((await post('a'.repeat(254) + '==', 'b'.repeat(256))).status).toBe(201);
    });

    it('F6b. a database error behind a route answers 500 INTERNAL without its message, and no log carries its parameters', async () => {
      h = await make();
      const endpoint = 'https://push.example.test/send/very-secret-endpoint-token-XYZ';
      const repo = h.dataSource.getRepository(InteractionWebPushSubscriptionEntity);
      jest.spyOn(repo, 'insert').mockRejectedValueOnce(new QueryFailedError('INSERT INTO "interaction_webpush_subscription" VALUES ($1, $2)', [endpoint, keys.p256dh], new Error('value too long for type character varying(256)')));
      const res = await http(h).post('/api/v1/interaction/me/webpush/subscriptions').set('Authorization', 'Bearer user-1').send({ endpoint, keys });
      expect([res.status, res.body.code, res.body.message]).toEqual([500, 'INTERNAL', 'Internal error']);
      const text = [...h.logs, JSON.stringify(res.body)].join('\n');
      for (const leak of ['very-secret-endpoint-token-XYZ', keys.p256dh, 'value too long', 'INSERT INTO']) expect(text).not.toContain(leak);
      expect(h.logs.some((line) => line.includes('route failed (QueryFailedError'))).toBe(true);
    });

    // -------------------------------------------------------------------------
    // F7: webhook — secret first, each update once
    // -------------------------------------------------------------------------

    it('F7a. webhook: the secret is compared before any database read or decryption; every refusal is the same 404', async () => {
      h = await make({ interaction_telegramInbound: 'webhook' });
      await linkOwnTelegram(h, 1);
      const store = h.get<InteractionSecretStore>(INTERACTION_SECRET_STORE);
      const reveal = jest.spyOn(store, 'reveal');
      const tokenFor = jest.spyOn(h.get(TelegramBotStateStore), 'tokenFor');
      const botId = BOT_TOKEN.split(':')[0];
      const strip = (body: Record<string, unknown>) => ({ code: body.code, message: body.message, statusCode: body.statusCode });
      const bodies: unknown[] = [];
      for (const path of [`u1/${botId}`, 'u77/7000077', `u1/${botId}1`, 'telegram/7000009', 'nope/1', 'u1/0x10']) {
        const res = await http(h).post(`/api/v1/interaction/telegram/webhook/${path}`).set('X-Telegram-Bot-Api-Secret-Token', 'x'.repeat(43)).send({ update_id: 1 });
        expect(res.status).toBe(404);
        bodies.push(strip(res.body));
      }
      expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
      expect(reveal).not.toHaveBeenCalled();
      expect(tokenFor).not.toHaveBeenCalled();
      // A valid secret for an id that is not the bot's any more (token replaced): 404 after the check.
      const other = h.get(InteractionKeyService).webhookSecret('u1', '7000077');
      expect((await http(h).post('/api/v1/interaction/telegram/webhook/u1/7000077').set('X-Telegram-Bot-Api-Secret-Token', other).send({ update_id: 1 })).status).toBe(404);
    });

    it('F7b. webhook: each update is handled at most once — a replay is refused, an OLDER one arriving late is handled once, a stale message never', async () => {
      h = await make({ interaction_telegramInbound: 'webhook' });
      await linkOwnTelegram(h, 1);
      let calls = 0;
      h.get(TelegramInboundRegistry).setMessageHandler(async () => {
        calls += 1;
      });
      const botId = BOT_TOKEN.split(':')[0];
      const secret = h.get(InteractionKeyService).webhookSecret('u1', botId);
      const post = (body: unknown) => http(h).post(`/api/v1/interaction/telegram/webhook/u1/${botId}`).set('X-Telegram-Bot-Api-Secret-Token', secret).send(body as object);
      for (const id of [42, 42, 41, 43, 41]) expect((await post(message(id, 'run the job'))).status).toBe(200);
      expect(calls).toBe(3);
      expect((await post({ message: message(44, 'no id').message })).status).toBe(200);
      expect(calls).toBe(3);
      // A message dated before the set's retention (a replay of captured traffic once its id was purged): never handled.
      expect((await post(message(45, 'captured', TG_ACCOUNT, Math.floor((Date.now() - 3 * 86_400_000) / 1000)))).status).toBe(200);
      expect(calls).toBe(3);
    });

    // -------------------------------------------------------------------------
    // F8: dedup by source, push hosts, no endpoint takeover, links cap
    // -------------------------------------------------------------------------

    it('F8a. a dedupKey is per source: another module’s notice with the same key never suppresses a security notice', async () => {
      h = await make();
      const api = h.get(UserInteractionService);
      await api.notify(1, { type: 'a.info', source: 'module-a', category: 'info', title: { raw: 'hello' }, dedupKey: 'acct:42' });
      const second = await api.notify(1, { type: 'b.security', source: 'mcp-access', category: 'security', title: { raw: 'Credential suspended' }, dedupKey: 'acct:42' });
      expect(second.deliveries[0]).toEqual({ kind: 'inapp', status: 'sent', code: null });
      const again = await api.notify(1, { type: 'b.security', source: 'mcp-access', category: 'security', title: { raw: 'Credential suspended' }, dedupKey: 'acct:42' });
      expect(again.deliveries[0]).toEqual({ kind: 'inapp', status: 'duplicate', code: null });
      expect(await h.dataSource.getRepository(InteractionNoticeEntity).count({ where: { userId: 1 } })).toBe(2);
    });

    it('F8b. web push endpoints: the major push services only (plus pushHostAllowlist); elsewhere refused, or with a neutral VAPID sub', async () => {
      h = await make({ interaction_vapidSubject: 'mailto:ops@company.example' }, { pushHostAllowlist: [] });
      const browser = h.get(BrowserChannelProvider);
      const subscribe = (endpoint: string, userId = 1) => browser.subscribe(owner(userId), { endpoint, keys, userAgent: null }).then(() => 'ok', codeOf);
      for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://wns2-par02p.notify.windows.com/w/?token=abc', 'https://web.push.apple.com/QXbc']) expect(await subscribe(endpoint)).toBe('ok');
      for (const endpoint of [ENDPOINT, 'https://fcm.googleapis.com:8443/fcm/send/x', 'https://fcm.googleapis.com.evil.example/x', 'https://push.apple.com/x', 'https://internal-partner.example.com:8443/admin/hook']) expect(await subscribe(endpoint)).toBe('INVALID_INPUT');
      // A stored row on another host (written before the list, or imported) is never sent to.
      const subs = h.dataSource.getRepository(InteractionWebPushSubscriptionEntity);
      await subs.insert({ userId: 2, endpoint: 'https://push.elsewhere.example/x', p256dh: keys.p256dh, auth: keys.auth, userAgent: null, lastUsedAt: null });
      await h.get(InteractionChannelService).configure(owner(2), 'browser', {});
      const report = await h.get(UserInteractionService).notify(2, { type: 'test.notice', source: 'tests', category: 'security', title: { raw: 'Hello there' } });
      expect(report.deliveries.find((d) => d.kind === 'browser')).toEqual({ kind: 'browser', status: 'failed', code: 'ADDRESS_REFUSED' });
      expect(h.push.sent).toHaveLength(0);
      await h.close();
      h = await make({ interaction_vapidSubject: 'mailto:ops@company.example' }, { pushHostAllowlist: ['push.example.test'], allowAnyPublicPushHost: true });
      await subscribeBrowser(h, 1);
      await h.get(BrowserChannelProvider).subscribe(owner(1), { endpoint: 'https://push.elsewhere.example/y', keys, userAgent: null });
      await h.get(UserInteractionService).notify(1, { type: 'test.notice', source: 'tests', category: 'security', title: { raw: 'Hello there' } });
      expect(Object.fromEntries(h.push.sent.map((sent) => [new URL(sent.endpoint).hostname, sent.subject]))).toEqual({ 'push.example.test': 'mailto:ops@company.example', 'push.elsewhere.example': 'https://app.test' });
    });

    it('F8c. a known endpoint re-posted by ANOTHER user with other keys is refused like a malformed one; its owner may renew it', async () => {
      h = await make();
      await subscribeBrowser(h, 1);
      const res = await http(h).post('/api/v1/interaction/me/webpush/subscriptions').set('Authorization', 'Bearer user-2').send({ endpoint: ENDPOINT, keys: { ...keys, auth: 'other' + 'd'.repeat(17) } });
      const malformed = await http(h).post('/api/v1/interaction/me/webpush/subscriptions').set('Authorization', 'Bearer user-2').send({ endpoint: 'http://x', keys });
      expect([res.status, res.body.code, res.body.message]).toEqual([400, 'INVALID_INPUT', malformed.body.message]);
      expect((await h.dataSource.getRepository(InteractionWebPushSubscriptionEntity).find({ where: { endpoint: ENDPOINT } })).map((row) => row.userId)).toEqual([1]);
      expect((await http(h).post('/api/v1/interaction/me/webpush/subscriptions').set('Authorization', 'Bearer user-1').send({ endpoint: ENDPOINT, keys: { ...keys, auth: 'renewed' + 'c'.repeat(16) } })).status).toBe(201);
      expect((await h.dataSource.getRepository(InteractionWebPushSubscriptionEntity).findOneByOrFail({ endpoint: ENDPOINT })).auth).toBe('renewed' + 'c'.repeat(16));
    });

    it('F8d. five accounts per bot even when the last links arrive together (record, then count)', async () => {
      h = await make();
      await linkOwnTelegram(h, 1);
      const links = h.get(TelegramLinkService);
      for (let i = 0; i < 2; i += 1) {
        const { code } = await links.issueCode('u1', 1);
        expect(await links.consume('u1', { telegramUserId: String(888_000 + i), chatId: String(888_000 + i), code, label: null, languageCode: null })).toBe('linked');
      }
      const codes = [];
      for (let i = 0; i < 5; i += 1) codes.push((await links.issueCode('u1', 1)).code);
      const outcomes = await Promise.all(codes.map((code, i) => links.consume('u1', { telegramUserId: String(999_000 + i), chatId: String(999_000 + i), code, label: null, languageCode: null })));
      expect(outcomes.every((outcome) => outcome === 'linked' || outcome === 'limit')).toBe(true);
      const count = await h.dataSource.getRepository(InteractionTelegramLinkEntity).count({ where: { botRef: 'u1' } });
      expect(count).toBeLessThanOrEqual(5);
      expect(count).toBe(3 + outcomes.filter((outcome) => outcome === 'linked').length);
    });

    // -------------------------------------------------------------------------
    // F9: audit, active check, the answer path of an app's in-app channel
    // -------------------------------------------------------------------------

    it('F9a. every answer and refused answer is audited with ids and codes only; a deactivated user answers nothing', async () => {
      h = await make();
      const ticket = await h.get(UserInteractionService).ask(1, question({ summary: { title: { raw: 'Send 10 ETH to 0xabc?' }, body: { raw: 'secret body' } } }));
      const tickets = h.get(InteractionTicketService);
      h.directory.users.get(1)!.active = false;
      expect((await http(h).post(`/api/v1/interaction/me/tickets/${ticket.id}/answer`).set('Authorization', 'Bearer user-1').send({ actionId: 'approve' })).status).toBe(404);
      await expect(tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'approve' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      h.directory.users.get(1)!.active = true;
      await tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'approve' });
      await expect(tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'deny' })).rejects.toMatchObject({ code: 'ALREADY_ANSWERED' });
      const audit = h.logs.filter((line) => line.includes('ticket.answer'));
      expect(audit).toContainEqual(expect.stringContaining(`ticket.answer kind=inapp owner=1 actor=user:1 ticket=${ticket.id} question=test.approval source=tests action=approve`));
      expect(audit).toContainEqual(expect.stringContaining(`ticket.answer_refused kind=inapp owner=1 actor=user:1 ticket=${ticket.id}`));
      expect(audit.filter((line) => line.includes('code=NOT_FOUND'))).toHaveLength(2);
      expect(audit.filter((line) => line.includes('code=ALREADY_ANSWERED'))).toHaveLength(1);
      for (const leak of ['Send 10 ETH', 'secret body']) expect(audit.join('\n')).not.toContain(leak);
    });

    it('F9b. answerFromProvider: the registered in-app provider answers like the in-app modal; anything else is refused', async () => {
      h = await make();
      const api = h.get(UserInteractionService);
      const provider = h.get(InAppReplyProvider);
      const ticket = await api.ask(1, question({ answerableFrom: ['inapp', 'hubchat'] }));
      // The user's channel of that kind must exist and be on (review F2).
      await expect(api.answerFromProvider(provider, { ticketId: ticket.id, userId: 1, actionId: 'approve' })).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
      await h.get(InteractionChannelService).configure(owner(1), 'hubchat', {});
      await h.get(InteractionChannelService).setState(owner(1), 'hubchat', { enabled: false });
      await expect(api.answerFromProvider(provider, { ticketId: ticket.id, userId: 1, actionId: 'approve' })).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
      await h.get(InteractionChannelService).setState(owner(1), 'hubchat', { enabled: true });
      // Channel on: only the registered in-app provider instance may answer through it.
      const impostor = { ...provider, kind: 'hubchat', proof: 'in_app', capabilities: provider.capabilities } as unknown as InteractionChannelProvider;
      const telegram = h.get(TelegramChannelProvider);
      for (const candidate of [impostor, telegram as unknown as InteractionChannelProvider, null as unknown as InteractionChannelProvider]) {
        await expect(api.answerFromProvider(candidate, { ticketId: ticket.id, userId: 1, actionId: 'approve' })).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
      }
      expect((await ticketRow(ticket.id)).status).toBe('open');
      await expect(api.answerFromProvider(provider, { ticketId: ticket.id, userId: 2, actionId: 'approve' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(api.answerFromProvider(provider, { ticketId: 'not-a-uuid', userId: 1, actionId: 'approve' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(api.answerFromProvider(provider, { ticketId: ticket.id, userId: 1, actionId: 'NOPE' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      const answered = await api.answerFromProvider(provider, { ticketId: ticket.id, userId: 1, actionId: 'approve' });
      expect(answered.status).toBe('answered');
      await idle(h);
      expect(handled).toEqual([expect.objectContaining({ ticketId: ticket.id, via: 'hubchat', actionId: 'approve' })]);
      // C2: an in-app channel is not « outside the app »: no `answered_elsewhere` trace; `getTicket` names the question it asks.
      expect(await h.dataSource.getRepository(InteractionNoticeEntity).count({ where: { userId: 1, type: 'interaction.answered_elsewhere' } })).toBe(0);
      expect(await api.getTicket(ticket.id)).toMatchObject({ id: ticket.id, kind: 'test.approval', source: 'tests', correlationId: expect.any(String), status: 'answered' });
      // freshProof: the provider brings the proof its in-app interface obtained.
      const fresh = await api.ask(1, question({ freshProof: true, answerableFrom: ['inapp', 'hubchat'] }));
      await expect(api.answerFromProvider(provider, { ticketId: fresh.id, userId: 1, actionId: 'approve' })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect((await api.answerFromProvider(provider, { ticketId: fresh.id, userId: 1, actionId: 'approve', stepUpProof: `ok:${stepUpPurposeOf(fresh.id)}:hub` })).status).toBe('answered');
      expect(await h.dataSource.getRepository(InteractionTicketEntity).count({ where: { answeredVia: 'hubchat', answeredAt: IsNull() } })).toBe(0);
    });

    // -------------------------------------------------------------------------
    // Second review pass (findings 1-4): the reviewer's P1, P2, P3, P5 turned around
    // -------------------------------------------------------------------------

    it('S1. a late BOT_IN_USE leaves the loser exactly as before (bot, secret, links); only the winner polls the contested bot', async () => {
      h = await make();
      await linkOwnTelegram(h, 1, BOT_TOKEN, TG_ACCOUNT);
      h.telegram.addBot(BOT_TOKEN_2, BOT_TOKEN_2.split(':')[0], 'bot_two');
      const rows = h.dataSource.getRepository(InteractionUserChannelEntity);
      const before = await rows.findOneByOrFail({ userId: 1, kind: 'telegram' });
      const store = h.get<InteractionSecretStore>(INTERACTION_SECRET_STORE);
      // User 1 is held between its early check and its secret write (whichever call it makes) while user 2 takes bot 2.
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => (held = resolve));
      const put = store.put.bind(store);
      const rotate = store.rotate.bind(store);
      jest.spyOn(store, 'put').mockImplementation(async (ownerUserId, kind, value) => {
        if (ownerUserId === 1) {
          held();
          await gate;
        }
        return put(ownerUserId, kind, value);
      });
      jest.spyOn(store, 'rotate').mockImplementation(async (id, ownerUserId, value) => {
        if (ownerUserId === 1) {
          held();
          await gate;
        }
        return rotate(id, ownerUserId, value);
      });
      const channels = h.get(InteractionChannelService);
      const first = channels.configure(owner(1), 'telegram', { mode: 'own', token: BOT_TOKEN_2 }).then(() => 'ok', codeOf);
      await reached;
      const second = await channels.configure(owner(2), 'telegram', { mode: 'own', token: BOT_TOKEN_2 }).then(() => 'ok', codeOf);
      release();
      expect([await first, second]).toEqual(['BOT_IN_USE', 'ok']);
      const after = await rows.findOneByOrFail({ userId: 1, kind: 'telegram' });
      expect([after.externalKey, after.secretId, after.config]).toEqual([before.externalKey, before.secretId, before.config]);
      expect(await store.reveal(after.secretId as string, 1)).toBe(BOT_TOKEN);
      expect(await h.dataSource.getRepository(InteractionSecretEntity).count({ where: { ownerUserId: 1 } })).toBe(1);
      expect((await h.get(TelegramLinkService).linksOf('u1', 1)).map((link) => link.telegramUserId)).toEqual([TG_ACCOUNT]);
      const state = h.get(TelegramBotStateStore);
      const tokens = [await state.tokenFor('u1'), await state.tokenFor('u2')].map((bot) => ('token' in bot ? bot.token : bot.code));
      expect(tokens).toEqual([BOT_TOKEN, BOT_TOKEN_2]);
    });

    it('S1b. a successful change of bot drops the old bot only after the write: links gone, one secret (the new one)', async () => {
      h = await make();
      await linkOwnTelegram(h, 1, BOT_TOKEN, TG_ACCOUNT);
      h.telegram.addBot(BOT_TOKEN_2, BOT_TOKEN_2.split(':')[0], 'bot_two');
      expect(await h.get(InteractionChannelService).configure(owner(1), 'telegram', { mode: 'own', token: BOT_TOKEN_2 }).then(() => 'ok', codeOf)).toBe('ok');
      const row = await h.dataSource.getRepository(InteractionUserChannelEntity).findOneByOrFail({ userId: 1, kind: 'telegram' });
      expect(row.externalKey).toBe(BOT_TOKEN_2.split(':')[0]);
      expect((await h.dataSource.getRepository(InteractionSecretEntity).find({ where: { ownerUserId: 1 } })).map((secret) => secret.id)).toEqual([row.secretId]);
      expect(await h.get<InteractionSecretStore>(INTERACTION_SECRET_STORE).reveal(row.secretId as string, 1)).toBe(BOT_TOKEN_2);
      expect(await h.get(TelegramLinkService).linksOf('u1', 1)).toEqual([]);
    });

    it('S2. a channel switched off during the step-up check, or right after the early check, refuses the answer at the decision', async () => {
      h = await make();
      const api = h.get(UserInteractionService);
      const channels = h.get(InteractionChannelService);
      const provider = h.get(InAppReplyProvider);
      await channels.configure(owner(1), 'hubchat', {});
      const ticket = await api.ask(1, question({ freshProof: true, answerableFrom: ['inapp', 'hubchat'] }));
      const port = h.get(GatedStepUp);
      port.during = async () => {
        port.during = null;
        await channels.adminSetDisabled({ userId: 9 }, 1, 'hubchat', true);
      };
      expect(await api.answerFromProvider(provider, { ticketId: ticket.id, userId: 1, actionId: 'approve', stepUpProof: `ok:${stepUpPurposeOf(ticket.id)}:x` }).then((t) => t.status, codeOf)).toBe('ADMIN_DISABLED');
      const row = await ticketRow(ticket.id);
      expect([row.status, row.dispatchStatus]).toEqual(['open', 'none']);
      // Without a proof: the owner switches the channel off right after the early check.
      await channels.adminSetDisabled({ userId: 9 }, 1, 'hubchat', false);
      const plain = await api.ask(1, question({ answerableFrom: ['inapp', 'hubchat'] }));
      const repo = h.dataSource.getRepository(InteractionUserChannelEntity);
      const findOne = repo.findOne.bind(repo);
      jest.spyOn(repo, 'findOne').mockImplementationOnce(async (...args: Parameters<typeof repo.findOne>) => {
        const found = await findOne(...args);
        await channels.setState(owner(1), 'hubchat', { enabled: false });
        return found;
      });
      expect(await api.answerFromProvider(provider, { ticketId: plain.id, userId: 1, actionId: 'approve' }).then((t) => t.status, codeOf)).toBe('CHANNEL_NOT_ALLOWED');
      expect((await ticketRow(plain.id)).status).toBe('open');
      await idle(h);
      expect(handled).toEqual([]);
    });

    it('S3. webhook semantics are AT MOST ONCE: the claim precedes the handling; a handler failure is acknowledged and never re-run', async () => {
      h = await make({ interaction_telegramInbound: 'webhook' });
      await linkOwnTelegram(h, 1);
      let calls = 0;
      h.get(TelegramInboundRegistry).setMessageHandler(async () => {
        calls += 1;
        if (calls === 1) throw new Error('handler down');
      });
      const botId = BOT_TOKEN.split(':')[0];
      const secret = h.get(InteractionKeyService).webhookSecret('u1', botId);
      const post = (body: unknown) => http(h).post(`/api/v1/interaction/telegram/webhook/u1/${botId}`).set('X-Telegram-Bot-Api-Secret-Token', secret).send(body as object);
      expect((await post(message(70, 'job'))).status).toBe(200);
      expect((await post(message(70, 'job'))).status).toBe(200);
      expect(calls).toBe(1);
      // Its id forgotten (purged after the retention), a FRESH message with that id is indistinguishable from a new one.
      await h.get(TelegramBotStateStore).purgeSeenUpdates(new Date(Date.now() + 1000));
      expect((await post(message(70, 'job'))).status).toBe(200);
      expect(calls).toBe(2);
      expect(await h.dataSource.getRepository(InteractionTelegramUpdateEntity).count({ where: { botRef: 'u1' } })).toBe(1);
    });

    it('S4. a known endpoint moves to another user only with the very same keys (same browser); other keys get the malformed-endpoint 400', async () => {
      h = await make();
      await subscribeBrowser(h, 1);
      const post = (token: string, body: Record<string, unknown>) => http(h).post('/api/v1/interaction/me/webpush/subscriptions').set('Authorization', `Bearer ${token}`).send(body);
      const malformed = await post('user-2', { endpoint: 'http://x', keys });
      const otherKeys = await post('user-2', { endpoint: ENDPOINT, keys: { ...keys, p256dh: 'BPk' + 'z'.repeat(80) } });
      expect([otherKeys.status, otherKeys.body.code, otherKeys.body.message, otherKeys.body.details]).toEqual([400, 'INVALID_INPUT', malformed.body.message, malformed.body.details]);
      const subs = h.dataSource.getRepository(InteractionWebPushSubscriptionEntity);
      expect((await subs.find({ where: { endpoint: ENDPOINT } })).map((row) => row.userId)).toEqual([1]);
      expect((await post('user-2', { endpoint: ENDPOINT, keys })).status).toBe(201);
      expect((await subs.find({ where: { endpoint: ENDPOINT } })).map((row) => row.userId)).toEqual([2]);
      expect((await post('user-1', { endpoint: ENDPOINT, keys: { ...keys, auth: 'renewed' + 'c'.repeat(16) } })).status).toBe(400);
    });
  });
}
