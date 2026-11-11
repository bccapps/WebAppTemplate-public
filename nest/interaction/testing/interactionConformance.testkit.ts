/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Conformance suite of the module (contract 04 §17), run on SQLite AND Postgres. Each test builds the module on a
// fresh database through `createInteractionHarness` (real services, controllers and auth interceptors; fake Telegram
// and Web Push: nothing leaves the process). Test 2 (browser permission → toast) is a front test
// (`react/interaction/pure/inappDisplay.spec.ts`). Tests 7 and 16 cover the webhook rules with the extension point (a
// `webhook` provider of the test) and the network guard, since this lot ships no webhook provider.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Inject, Injectable, type Type } from '@nestjs/common';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { IsNull } from 'typeorm';
import { CryptService } from '../../common/services/CryptService';
import { CryptInteractionSecretStore } from '../adapters/CryptInteractionSecretStore';
import { InteractionLinkCodeEntity } from '../entities/InteractionLinkCodeEntity';
import { InteractionSecretEntity } from '../entities/InteractionSecretEntity';
import { InteractionTelegramLinkEntity } from '../entities/InteractionTelegramLinkEntity';
import { InteractionTicketCardEntity } from '../entities/InteractionTicketCardEntity';
import { InteractionTicketEntity } from '../entities/InteractionTicketEntity';
import { InteractionError, isInteractionError } from '../errors/InteractionError';
import { InteractionSendQuotaService } from '../services/InteractionSendQuotaService';
import { InteractionKeyService } from '../services/InteractionKeyService';
import { InteractionPrefService } from '../services/InteractionPrefService';
import { TelegramLinkService } from '../providers/telegram/TelegramLinkService';
import { InteractionBackground } from '../services/InteractionRuntime';
import { InteractionChannelService } from '../services/InteractionChannelService';
import { InteractionTicketService } from '../services/InteractionTicketService';
import { UserInteractionService } from '../services/UserInteractionService';
import { BrowserChannelProvider } from '../providers/browser/BrowserChannelProvider';
import { WebPushSender } from '../providers/browser/WebPushSender';
import { TelegramBotFleet } from '../providers/telegram/TelegramBotFleet';
import { TelegramBotStateStore } from '../providers/telegram/TelegramBotStateStore';
import { TelegramChannelProvider } from '../providers/telegram/TelegramChannelProvider';
import { TelegramUpdateHandler } from '../providers/telegram/TelegramUpdateHandler';
import { parseCallback, signCallback } from '../pure/telegramCallback';
import { guardedRequest, isBlockedAddress, NetGuardError, validateTargetUrl, type AddressGuard } from '../utils/netGuard';
import { INTERACTION_SECRET_STORE, type InteractionSecretStore, type InteractionStepUpPort, type StepUpMethod } from '../types/ports';
import type { InteractionQuestion, UserNotice } from '../types/interactionTypes';
import type { ChannelConfigureResult, ChannelOwner, InteractionChannelProvider, StoredChannel } from '../types/providerTypes';
import { createInteractionHarness, type Harness, type HarnessDatabase } from './interactionHarness';

// ---------------------------------------------------------------------------
// Providers of the tests (the extension point of 04 §4.6)
// ---------------------------------------------------------------------------

const ready = { ready: true, code: null };
function base(kind: string): Omit<InteractionChannelProvider, 'send'> {
  return {
    kind,
    capabilities: new Set(['notify'] as const),
    proof: 'link',
    configSchema: { parse: (input: unknown) => input, secretFields: [] },
    requiresVerification: false,
    configure: async (owner: ChannelOwner, _input: unknown, current: StoredChannel | null): Promise<ChannelConfigureResult> => ({
      channel: current ?? { id: '', userId: owner.userId, kind, enabled: true, adminDisabled: false, position: 0, config: { on: true }, verification: null, secretId: null, externalKey: null, verifiedAt: new Date() },
      secretOnce: null,
    }),
    verify: async (_owner: ChannelOwner, channel: StoredChannel) => channel,
    isReady: async () => true,
    readiness: async () => ready,
    ownerView: async () => ({}),
    adminView: async () => ({}),
  };
}

/** A provider that throws on every send (with a message that must never reach a row or a log). */
@Injectable()
export class ThrowingProvider implements InteractionChannelProvider {
  private readonly b = base('boom');
  readonly kind = this.b.kind;
  readonly capabilities = this.b.capabilities;
  readonly proof = this.b.proof;
  readonly configSchema = this.b.configSchema;
  readonly requiresVerification = false;
  configure = this.b.configure;
  verify = this.b.verify;
  isReady = this.b.isReady;
  readiness = this.b.readiness;
  ownerView = this.b.ownerView;
  adminView = this.b.adminView;
  async send(): Promise<never> {
    throw new Error('boom leaked-detail https://internal.example/secret');
  }
}

/** A provider that never answers (the per-provider timeout must free the others). */
@Injectable()
export class HangingProvider implements InteractionChannelProvider {
  private readonly b = base('slow');
  readonly kind = this.b.kind;
  readonly capabilities = this.b.capabilities;
  readonly proof = this.b.proof;
  readonly configSchema = this.b.configSchema;
  readonly requiresVerification = false;
  configure = this.b.configure;
  verify = this.b.verify;
  isReady = this.b.isReady;
  readiness = this.b.readiness;
  ownerView = this.b.ownerView;
  adminView = this.b.adminView;
  send(): Promise<never> {
    return new Promise(() => undefined);
  }
}

/** A webhook-like provider of the app: its signing key is shown ONCE (configure, rotate), its URL to its owner only. */
@Injectable()
export class TestWebhookProvider implements InteractionChannelProvider {
  private readonly b = base('webhook');
  readonly kind = 'webhook';
  readonly capabilities = this.b.capabilities;
  readonly proof = this.b.proof;
  readonly configSchema = this.b.configSchema;
  readonly requiresVerification = false;
  verify = this.b.verify;
  isReady = this.b.isReady;
  readiness = this.b.readiness;
  constructor(@Inject(INTERACTION_SECRET_STORE) private readonly secrets: InteractionSecretStore) {}
  async configure(owner: ChannelOwner, input: unknown, current: StoredChannel | null): Promise<ChannelConfigureResult> {
    const url = validateTargetUrl((input as { url?: unknown })?.url, { admin: owner.admin }).toString();
    const secret = `whsec_${'k'.repeat(24)}${Date.now()}`;
    const secretId = current?.secretId ?? (await this.secrets.put(owner.userId, 'webhook', secret));
    if (current?.secretId) await this.secrets.rotate(current.secretId, owner.userId, secret);
    const channel = current ?? { id: '', userId: owner.userId, kind: 'webhook', enabled: true, adminDisabled: false, position: 0, config: {}, verification: null, secretId: null, externalKey: null, verifiedAt: null };
    return { channel: { ...channel, config: { url }, secretId, verifiedAt: new Date() }, secretOnce: secret };
  }
  async rotateSecret(owner: ChannelOwner, channel: StoredChannel): Promise<ChannelConfigureResult> {
    const secret = `whsec_${'r'.repeat(24)}${Date.now()}`;
    await this.secrets.rotate(channel.secretId as string, owner.userId, secret);
    return { channel, secretOnce: secret };
  }
  async send(): Promise<{ ok: boolean; code: string | null }> {
    return { ok: true, code: null };
  }
  async ownerView(channel: StoredChannel): Promise<Record<string, unknown>> {
    return { url: channel.config.url };
  }
  async adminView(): Promise<Record<string, string | number | boolean | null>> {
    return { configured: true };
  }
}

/** A step-up port: a proof `ok:<purpose>` is accepted once. */
@Injectable()
export class TestStepUp implements InteractionStepUpPort {
  readonly consumed = new Set<string>();
  async methods(): Promise<StepUpMethod[]> {
    return ['email_code'];
  }
  async begin(): Promise<Record<string, unknown>> {
    return {};
  }
  async complete(): Promise<{ proofId: string }> {
    return { proofId: 'x' };
  }
  async consume(proofId: string, purpose: string): Promise<boolean> {
    if (proofId !== `ok:${purpose}` || this.consumed.has(proofId)) return false;
    this.consumed.add(proofId);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const BOT_TOKEN = '7000001:AAH-test-token-of-user-one-0123456789';
export const BOT_TOKEN_2 = '7000002:AAH-test-token-of-user-two-0123456789';
export const TG_ACCOUNT = '777000123';
export const TG_ACCOUNT_2 = '777000456';
export const ENDPOINT = 'https://push.example.test/send/abc-endpoint-secret-0001';

export const owner = (userId: number): ChannelOwner => ({ userId, admin: false, ip: '203.0.113.9' });

export function notice(extra: Partial<UserNotice> = {}): UserNotice {
  return { type: 'test.notice', source: 'tests', category: 'info', title: { raw: 'Hello there' }, ...extra };
}

export function question(extra: Partial<InteractionQuestion> = {}): InteractionQuestion {
  return {
    kind: 'test.approval',
    source: 'tests',
    correlationId: `c-${Math.random().toString(36).slice(2)}`,
    category: 'approval',
    summary: { title: { raw: 'Approve the order?' }, body: { raw: 'Buy 1 BTC' } },
    actions: [
      { id: 'approve', label: { raw: 'Approve' }, style: 'primary' },
      { id: 'deny', label: { raw: 'Deny' }, style: 'danger' },
    ],
    expiresAt: new Date(Date.now() + 120_000),
    ...extra,
  };
}

export function startUpdate(updateId: number, account: string, code: string): unknown {
  return { update_id: updateId, message: { message_id: updateId, date: 1, chat: { id: Number(account), type: 'private' }, from: { id: Number(account), is_bot: false, username: 'alice', language_code: 'en' }, text: `/start ${code}` } };
}

export function pressUpdate(updateId: number, press: { account: string; chatId: string; messageId: string; data: string }): unknown {
  return {
    update_id: updateId,
    callback_query: { id: `cbq-${updateId}`, from: { id: Number(press.account), is_bot: false, language_code: 'en' }, message: { message_id: Number(press.messageId), chat: { id: Number(press.chatId), type: 'private' } }, data: press.data },
  };
}

export interface TelegramSetup {
  botRef: string;
  token: string;
  account: string;
}

/** User `userId` with their own bot and one account linked by `/start <code>`. */
export async function linkOwnTelegram(h: Harness, userId: number, token = BOT_TOKEN, account = TG_ACCOUNT): Promise<TelegramSetup> {
  h.telegram.addBot(token, token.split(':')[0], `bot_of_${userId}`);
  await h.get(InteractionChannelService).configure(owner(userId), 'telegram', { mode: 'own', token });
  const { code } = await h.get(TelegramChannelProvider).linkCode(owner(userId));
  await h.get(TelegramUpdateHandler).handle(`u${userId}`, token, startUpdate(1, account, code));
  return { botRef: `u${userId}`, token, account };
}

export async function subscribeBrowser(h: Harness, userId: number, endpoint = ENDPOINT): Promise<void> {
  await h.get(BrowserChannelProvider).subscribe(owner(userId), { endpoint, keys: { p256dh: 'BPk' + 'a'.repeat(80), auth: 'auth' + 'b'.repeat(18) }, userAgent: 'Test/1.0' });
}

export function http(h: Harness): request.Agent {
  return request.agent(h.app.getHttpServer());
}

export async function idle(h: Harness): Promise<void> {
  await h.get(InteractionBackground).idle();
}

/** The last card message sent to a chat and its buttons' callback data. */
export function lastCard(h: Harness): { messageId: string; data: string[] } {
  const card = [...h.telegram.sent()].reverse().find((call) => call.keyboard?.inline_keyboard.some((row) => row.some((button) => 'callback_data' in button)));
  if (!card) throw new Error('no card sent');
  const data = (card.keyboard?.inline_keyboard ?? []).flat().flatMap((button) => ('callback_data' in button ? [button.callback_data] : []));
  return { messageId: card.messageId as string, data };
}

function utcHhmm(offsetMinutes: number): string {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

export async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let error: unknown = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(isInteractionError(error) ? error.code : error).toBe(code);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export interface ConformanceOptions {
  /** A fresh database per test; `restart` = a database a second harness can reopen (SQLite file / same Postgres schema). */
  database: (purpose: 'fresh' | 'restart') => HarnessDatabase;
}

export const ENABLED = ['browser', 'telegram', 'boom', 'slow', 'webhook'];
export const EXTRA: Type<InteractionChannelProvider>[] = [ThrowingProvider, HangingProvider, TestWebhookProvider];

export function describeInteractionConformance(label: string, options: ConformanceOptions): void {
  describe(`interaction conformance (04 §17) — ${label}`, () => {
    let h: Harness;
    const handled: Array<{ ticketId: string; status: string; actionId: string | null; via: string | null }> = [];

    async function harness(config: Record<string, unknown> = {}, extra: { stepUp?: boolean; database?: HarnessDatabase; keepData?: boolean } = {}): Promise<Harness> {
      const created = await createInteractionHarness({
        database: extra.database ?? options.database('fresh'),
        keepData: extra.keepData,
        config: { interaction_enabledKinds: ENABLED, interaction_providerTimeoutMs: 1000, ...config },
        providers: EXTRA,
        stepUp: extra.stepUp ? TestStepUp : undefined,
      });
      for (const id of [1, 2, 3]) created.directory.add(id);
      created.directory.add(9, { admin: true });
      created.get(UserInteractionService).onAnswer('test.approval', async (answer) => {
        handled.push({ ticketId: answer.ticketId, status: answer.status, actionId: answer.actionId, via: answer.via });
      });
      return created;
    }

    beforeEach(async () => {
      handled.length = 0;
      h = await harness();
    });

    afterEach(async () => {
      await idle(h).catch(() => undefined);
      await h.close();
    });

    it('1. inapp is always delivered: channels off, admin-disabled, quiet hours, cap reached, provider throwing', async () => {
      const service = h.get(UserInteractionService);
      const channels = h.get(InteractionChannelService);
      await linkOwnTelegram(h, 1);
      await subscribeBrowser(h, 1);
      await channels.configure(owner(1), 'boom', {});
      const inapp = async (extra: Partial<UserNotice> = {}) => {
        const report = await service.notify(1, notice(extra));
        expect(report.deliveries[0]).toEqual({ kind: 'inapp', status: 'sent', code: null });
        expect(report.noticeId).not.toBeNull();
        return report;
      };
      const thrown = await inapp();
      expect(thrown.deliveries.find((d) => d.kind === 'boom')).toEqual({ kind: 'boom', status: 'failed', code: 'ERROR' });
      await channels.setState(owner(1), 'telegram', { enabled: false });
      await channels.setState(owner(1), 'browser', { enabled: false });
      await channels.setState(owner(1), 'boom', { enabled: false });
      expect((await inapp()).outcome).toBe('inapp_only');
      await channels.adminSetDisabled({ userId: 9 }, 1, 'telegram', true);
      await channels.setState(owner(1), 'browser', { enabled: true });
      await h.get(InteractionPrefService).save(1, { quietHours: { start: utcHhmm(-60), end: utcHhmm(60) }, timezone: 'UTC' });
      const quiet = await inapp();
      expect(quiet.deliveries.find((d) => d.kind === 'browser')).toEqual({ kind: 'browser', status: 'skipped', code: 'QUIET_HOURS' });
      expect(quiet.deliveries.find((d) => d.kind === 'telegram')?.code).toBe('ADMIN_DISABLED');
      await h.get(InteractionPrefService).save(1, { quietHours: null });
      h.config.values.set('interaction_maxPerUserHour', 0);
      const capped = await inapp();
      expect(capped.deliveries.find((d) => d.kind === 'browser')).toEqual({ kind: 'browser', status: 'skipped', code: 'CAPPED' });
      const inbox = await http(h).get('/api/v1/interaction/me/inbox').set('Authorization', 'Bearer user-1');
      expect(inbox.status).toBe(200);
      expect(inbox.body.notices.filter((n: { type: string }) => n.type === 'test.notice')).toHaveLength(4);
    });

    it('3. a throwing provider and a hanging one never block the others; failures are recorded with a code', async () => {
      const channels = h.get(InteractionChannelService);
      await linkOwnTelegram(h, 1);
      await channels.configure(owner(1), 'boom', {});
      await channels.configure(owner(1), 'slow', {});
      const started = Date.now();
      const report = await h.get(UserInteractionService).notify(1, notice({ category: 'security' }));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(report.outcome).toBe('delivered');
      expect(report.deliveries.find((d) => d.kind === 'telegram')).toEqual({ kind: 'telegram', status: 'sent', code: null });
      expect(report.deliveries.find((d) => d.kind === 'boom')).toEqual({ kind: 'boom', status: 'failed', code: 'ERROR' });
      expect(report.deliveries.find((d) => d.kind === 'slow')).toEqual({ kind: 'slow', status: 'failed', code: 'TIMEOUT' });
      expect((await channels.rowOf(1, 'boom'))?.lastError).toBe('ERROR');
      expect((await channels.rowOf(1, 'slow'))?.lastError).toBe('TIMEOUT');
      expect(h.logs.join('\n')).not.toContain('leaked-detail');
    });

    it('4. 20 concurrent notify with the same dedupKey: one delivery per channel, the rest duplicate', async () => {
      await linkOwnTelegram(h, 1);
      await subscribeBrowser(h, 1);
      const reports = await Promise.all(Array.from({ length: 20 }, () => h.get(UserInteractionService).notify(1, notice({ dedupKey: 'same-key' }))));
      for (const kind of ['inapp', 'telegram', 'browser']) {
        const statuses = reports.map((report) => report.deliveries.find((d) => d.kind === kind)?.status);
        expect(statuses.filter((status) => status === 'sent')).toHaveLength(1);
        expect(statuses.filter((status) => status === 'duplicate')).toHaveLength(19);
      }
      expect(reports.filter((report) => report.noticeId !== null)).toHaveLength(1);
      expect(h.telegram.sent().filter((call) => call.text?.includes('Hello there'))).toHaveLength(1);
      expect(h.push.sent).toHaveLength(1);
    });

    it('5. admin_disabled: nothing sent, bot not polled, owner can neither re-enable nor delete, the admin lifts it', async () => {
      const tg = await linkOwnTelegram(h, 1);
      const fleet = h.get(TelegramBotFleet);
      expect(await fleet.wantedBots()).toContain(tg.botRef);
      const disable = await http(h).patch('/api/v1/admin/interaction/users/1/channels/telegram').set('Authorization', 'Bearer admin-user-9').send({ adminDisabled: true });
      expect(disable.status).toBe(200);
      const report = await h.get(UserInteractionService).notify(1, notice({ category: 'security' }));
      expect(report.deliveries.find((d) => d.kind === 'telegram')).toEqual({ kind: 'telegram', status: 'skipped', code: 'ADMIN_DISABLED' });
      expect(await fleet.wantedBots()).not.toContain(tg.botRef);
      expect('code' in (await h.get(TelegramBotStateStore).tokenFor(tg.botRef))).toBe(true);
      const polls = h.telegram.calls.filter((call) => call.method === 'getUpdates').length;
      expect(await fleet.pollOnce(tg.botRef)).toBeNull();
      expect(h.telegram.calls.filter((call) => call.method === 'getUpdates')).toHaveLength(polls);
      const enable = await http(h).patch('/api/v1/interaction/me/channels/telegram').set('Authorization', 'Bearer user-1').send({ enabled: true });
      expect([enable.status, enable.body.code]).toEqual([409, 'ADMIN_DISABLED']);
      const remove = await http(h).delete('/api/v1/interaction/me/channels/telegram').set('Authorization', 'Bearer user-1');
      expect([remove.status, remove.body.code]).toEqual([409, 'ADMIN_DISABLED']);
      const lift = await http(h).patch('/api/v1/admin/interaction/users/1/channels/telegram').set('Authorization', 'Bearer admin-key').send({ adminDisabled: false });
      expect(lift.status).toBe(200);
      expect((await http(h).patch('/api/v1/interaction/me/channels/telegram').set('Authorization', 'Bearer user-1').send({ enabled: true })).status).toBe(200);
      expect(await fleet.wantedBots()).toContain(tg.botRef);
      expect(h.logs.some((line) => line.includes('channel.admin_disable') && line.includes('kind=telegram'))).toBe(true);
    });

    it('6. admin views and logs never carry an address, URL, chat id, Telegram id, endpoint or token', async () => {
      await linkOwnTelegram(h, 1);
      await subscribeBrowser(h, 1);
      await h.get(InteractionChannelService).configure({ ...owner(1), admin: false }, 'webhook', { url: 'https://hooks.example.test/private-path-xyz' });
      await h.get(UserInteractionService).notify(1, notice({ title: { raw: 'Top secret title 42' } }));
      const ticket = await h.get(UserInteractionService).ask(1, question());
      await idle(h);
      const admin = http(h);
      const bodies = await Promise.all(
        ['/channels', '/deliveries', '/tickets', '/telegram/bots'].map(async (path) => JSON.stringify((await admin.get(`/api/v1/admin/interaction${path}`).set('Authorization', 'Bearer admin-key')).body)),
      );
      const leaks = [TG_ACCOUNT, BOT_TOKEN, BOT_TOKEN.split(':')[1], 'abc-endpoint-secret', 'push.example.test', 'hooks.example.test', 'private-path-xyz', 'Top secret title', 'Approve the order', 'Buy 1 BTC', 'whsec_'];
      for (const body of bodies) for (const leak of leaks) expect(body).not.toContain(leak);
      expect(bodies[0]).toContain('"telegram"');
      expect(bodies[2]).toContain(ticket.id);
      const logs = h.logs.join('\n');
      for (const leak of leaks) expect(logs).not.toContain(leak);
    });

    it('7. a webhook key is shown once; a bot token is never returned', async () => {
      const agent = http(h);
      const created = await agent.put('/api/v1/interaction/me/channels/webhook').set('Authorization', 'Bearer user-1').send({ url: 'https://hooks.example.test/a' });
      expect(created.status).toBe(200);
      expect(created.body.secret).toMatch(/^whsec_/);
      const list = JSON.stringify((await agent.get('/api/v1/interaction/me/channels').set('Authorization', 'Bearer user-1')).body);
      expect(list).not.toContain(created.body.secret);
      expect(list).not.toContain('whsec_');
      const rotated = await agent.post('/api/v1/interaction/me/channels/webhook/secret').set('Authorization', 'Bearer user-1');
      expect(rotated.body.secret).toMatch(/^whsec_/);
      expect(rotated.body.secret).not.toBe(created.body.secret);
      expect(JSON.stringify((await agent.get('/api/v1/interaction/me/channels').set('Authorization', 'Bearer user-1')).body)).not.toContain(rotated.body.secret);
      h.telegram.addBot(BOT_TOKEN, '7000001', 'bot_of_1');
      const tg = await agent.put('/api/v1/interaction/me/channels/telegram').set('Authorization', 'Bearer user-1').send({ mode: 'own', token: BOT_TOKEN });
      expect(tg.status).toBe(200);
      expect(tg.body.secret).toBeNull();
      const all = JSON.stringify(tg.body) + JSON.stringify((await agent.get('/api/v1/interaction/me/channels').set('Authorization', 'Bearer user-1')).body);
      expect(all).not.toContain(BOT_TOKEN.split(':')[1]);
      expect(all).toContain('bot_of_1');
    });

    it('8. approval / security: empty route refused, never held by quiet hours, re-routed when the route has no ready channel; info held', async () => {
      const agent = http(h);
      for (const category of ['approval', 'security']) {
        const res = await agent.put('/api/v1/interaction/me/prefs').set('Authorization', 'Bearer user-1').send({ routing: { [category]: [] } });
        expect([res.status, res.body.code]).toEqual([422, 'ROUTE_REQUIRED']);
      }
      expect((await agent.put('/api/v1/interaction/me/prefs').set('Authorization', 'Bearer user-1').send({ routing: { info: [] } })).status).toBe(200);
      await linkOwnTelegram(h, 1);
      const service = h.get(UserInteractionService);
      await agent.put('/api/v1/interaction/me/prefs').set('Authorization', 'Bearer user-1').send({ quietHours: { start: utcHhmm(-60), end: utcHhmm(60) }, timezone: 'UTC', routing: { info: null } });
      expect((await service.notify(1, notice({ category: 'security' }))).deliveries.find((d) => d.kind === 'telegram')?.status).toBe('sent');
      expect((await service.notify(1, notice({ category: 'info' }))).deliveries.find((d) => d.kind === 'telegram')?.code).toBe('QUIET_HOURS');
      await agent.put('/api/v1/interaction/me/prefs').set('Authorization', 'Bearer user-1').send({ quietHours: null, routing: { security: ['browser'], info: ['browser'] } });
      expect((await service.notify(1, notice({ category: 'security' }))).deliveries.find((d) => d.kind === 'telegram')?.status).toBe('sent');
      expect((await service.notify(1, notice({ category: 'info' }))).deliveries.find((d) => d.kind === 'telegram')?.code).toBe('ROUTED_OFF');
    });

    it('9. 50 concurrent answers (in-app and Telegram): one winner, the others ALREADY_ANSWERED', async () => {
      const tg = await linkOwnTelegram(h, 1);
      const ticket = await h.get(UserInteractionService).ask(1, question());
      await idle(h);
      const card = lastCard(h);
      const handler = h.get(TelegramUpdateHandler);
      const tickets = h.get(InteractionTicketService);
      const results = await Promise.all([
        ...Array.from({ length: 25 }, () => tickets.answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'approve' }).then(() => 'won', (error: unknown) => (isInteractionError(error) ? error.code : 'error'))),
        ...Array.from({ length: 25 }, (_, i) =>
          handler.cardPress(tg.botRef, { callbackId: `c${i}`, telegramUserId: tg.account, chatId: tg.account, messageId: card.messageId, data: card.data[1], languageCode: 'en' }).then((verdict) => (verdict.ok ? 'won' : verdict.reason)),
        ),
      ]);
      expect(results.filter((result) => result === 'won')).toHaveLength(1);
      expect(results.filter((result) => result !== 'won').every((result) => result === 'ALREADY_ANSWERED' || result === 'UNKNOWN_CARD')).toBe(true);
      await idle(h);
      expect(handled.filter((entry) => entry.ticketId === ticket.id)).toHaveLength(1);
    });

    it('10. an answer after expires_at, before the sweep, is EXPIRED; the handler never gets « answered »', async () => {
      const ticket = await h.get(UserInteractionService).ask(1, question());
      await h.dataSource.getRepository(InteractionTicketEntity).update({ id: ticket.id }, { expiresAt: new Date(Date.now() - 1000) });
      const res = await http(h).post(`/api/v1/interaction/me/tickets/${ticket.id}/answer`).set('Authorization', 'Bearer user-1').send({ actionId: 'approve' });
      expect([res.status, res.body.code]).toEqual([410, 'EXPIRED']);
      await idle(h);
      expect(handled).toHaveLength(0);
      await h.get(InteractionTicketService).expireDue();
      await idle(h);
      expect(handled).toEqual([{ ticketId: ticket.id, status: 'expired', actionId: null, via: null }]);
    });

    it('11. the sweep hands « expired » over once and closes the cards; cancel → cancelled, answers refused', async () => {
      await linkOwnTelegram(h, 1);
      const tickets = h.get(InteractionTicketService);
      const ticket = await h.get(UserInteractionService).ask(1, question());
      await idle(h);
      const card = lastCard(h);
      await h.dataSource.getRepository(InteractionTicketEntity).update({ id: ticket.id }, { expiresAt: new Date(Date.now() - 1000) });
      expect(await tickets.expireDue()).toBe(1);
      await idle(h);
      expect(await tickets.expireDue()).toBe(0);
      await idle(h);
      expect(handled).toEqual([{ ticketId: ticket.id, status: 'expired', actionId: null, via: null }]);
      expect((await h.dataSource.getRepository(InteractionTicketCardEntity).find({ where: { ticketId: ticket.id } })).every((row) => row.state === 'closed')).toBe(true);
      expect(h.telegram.calls.some((call) => call.method === 'editMessageText' && call.messageId === card.messageId)).toBe(true);
      const other = await h.get(UserInteractionService).ask(1, question({ correlationId: 'to-cancel' }));
      expect(await h.get(UserInteractionService).cancel('tests', 'to-cancel', 'test')).toBe(true);
      expect(await h.get(UserInteractionService).cancel('tests', 'to-cancel', 'test')).toBe(false);
      await expectCode(tickets.answer({ ticketId: other.id, userId: 1, via: 'inapp', actionId: 'approve' }), 'CANCELLED');
      await idle(h);
      expect(handled.filter((entry) => entry.ticketId === other.id)).toEqual([{ ticketId: other.id, status: 'cancelled', actionId: null, via: null }]);
    });

    it('12. a failing handler is retried; the outcome survives a restart and is handed over once', async () => {
      const database = options.database('restart');
      await h.close();
      h = await harness({}, { database });
      let failures = 0;
      const first = h.get(UserInteractionService);
      first.onAnswer('test.flaky', async () => {
        failures += 1;
        throw new Error('handler down');
      });
      const ticket = await first.ask(1, question({ kind: 'test.flaky' }));
      await h.get(InteractionTicketService).answer({ ticketId: ticket.id, userId: 1, via: 'inapp', actionId: 'deny' });
      await idle(h);
      expect(failures).toBe(1);
      const row = await h.dataSource.getRepository(InteractionTicketEntity).findOneByOrFail({ id: ticket.id });
      expect([row.dispatchStatus, row.dispatchAttempts]).toEqual(['pending', 1]);
      await h.close();
      h = await harness({}, { database, keepData: true });
      const received: string[] = [];
      h.get(UserInteractionService).onAnswer('test.flaky', async (answer) => {
        received.push(`${answer.status}:${answer.actionId}`);
      });
      await h.get(InteractionTicketService).retryDispatches(new Date(Date.now() + 15_000));
      await h.get(InteractionTicketService).retryDispatches(new Date(Date.now() + 15_000));
      expect(received).toEqual(['answered:deny']);
      expect((await h.dataSource.getRepository(InteractionTicketEntity).findOneByOrFail({ id: ticket.id })).dispatchStatus).toBe('done');
    });

    it('13. answerableFrom [inapp]: the Telegram message has no answer button; a forged press is refused', async () => {
      const tg = await linkOwnTelegram(h, 1);
      const ticket = await h.get(UserInteractionService).ask(1, question({ answerableFrom: ['inapp'] }));
      await idle(h);
      const message = h.telegram.sent().find((call) => call.text?.includes('Approve the order'));
      expect(message).toBeDefined();
      expect((message?.keyboard?.inline_keyboard ?? []).flat().some((button) => 'callback_data' in button)).toBe(false);
      expect(await h.dataSource.getRepository(InteractionTicketCardEntity).count({ where: { ticketId: ticket.id } })).toBe(0);
      const forged = `ix:${'A'.repeat(12)}:0:${'B'.repeat(8)}`;
      await h.get(TelegramUpdateHandler).handle(tg.botRef, tg.token, pressUpdate(50, { account: tg.account, chatId: tg.account, messageId: message?.messageId as string, data: forged }));
      expect(h.telegram.calls.filter((call) => call.method === 'answerCallbackQuery').pop()?.text).toBe('This button is no longer active.');
      expect((await h.get(UserInteractionService).getTicket(ticket.id))?.status).toBe('open');
    });

    it('14. Telegram presses that do not match the whole binding are refused generically, and change nothing', async () => {
      const tg = await linkOwnTelegram(h, 1);
      const other = await linkOwnTelegram(h, 2, BOT_TOKEN_2, TG_ACCOUNT_2);
      const ticket = await h.get(UserInteractionService).ask(1, question());
      await idle(h);
      const card = lastCard(h);
      const parsed = parseCallback(card.data[0]);
      const handler = h.get(TelegramUpdateHandler);
      const generic = 'This button is no longer active.';
      const lastAnswer = () => h.telegram.calls.filter((call) => call.method === 'answerCallbackQuery').pop()?.text;
      const good = { account: tg.account, chatId: tg.account, messageId: card.messageId, data: card.data[0] };
      const refused = async (botRef: string, token: string, press: typeof good, id: number): Promise<void> => {
        await handler.handle(botRef, token, pressUpdate(id, press));
        expect(lastAnswer()).toBe(generic);
        expect((await h.get(UserInteractionService).getTicket(ticket.id))?.status).toBe('open');
      };
      await refused(tg.botRef, tg.token, { ...good, data: `${card.data[0].slice(0, -1)}${card.data[0].endsWith('A') ? 'B' : 'A'}` }, 60);
      const key = h.get(InteractionKeyService).callbackKey();
      await refused(tg.botRef, tg.token, { ...good, data: signCallback(key, tg.botRef, 'Z'.repeat(12), 0) }, 61);
      await refused(other.botRef, other.token, good, 62);
      await refused(other.botRef, other.token, { ...good, data: signCallback(key, other.botRef, parsed?.cardKey as string, 0) }, 63);
      await refused(tg.botRef, tg.token, { ...good, chatId: '999999' }, 64);
      await refused(tg.botRef, tg.token, { ...good, messageId: String(Number(card.messageId) + 1) }, 65);
      await refused(tg.botRef, tg.token, { ...good, account: TG_ACCOUNT_2 }, 66);
      const links = h.dataSource.getRepository(InteractionTelegramLinkEntity);
      await links.update({ botRef: tg.botRef }, { source: 'legacy' });
      await refused(tg.botRef, tg.token, good, 67);
      await links.update({ botRef: tg.botRef }, { source: 'code' });
      h.directory.users.get(1)!.active = false;
      await refused(tg.botRef, tg.token, good, 68);
      h.directory.users.get(1)!.active = true;
      const link = await links.findOneByOrFail({ botRef: tg.botRef });
      await links.delete({ id: link.id });
      await refused(tg.botRef, tg.token, good, 69);
      await links.save(link);
      await handler.handle(tg.botRef, tg.token, pressUpdate(70, good));
      expect(lastAnswer()).toBe('Answer recorded.');
      await idle(h);
      await handler.handle(tg.botRef, tg.token, pressUpdate(70, good));
      expect(lastAnswer()).toBe(generic);
      expect(handled).toEqual([{ ticketId: ticket.id, status: 'answered', actionId: 'approve', via: 'telegram' }]);
    });

    it('15. link codes: single use under concurrency, expired refused, account of another user → conflict', async () => {
      h.telegram.addBot(BOT_TOKEN, '7000001', 'bot_of_1');
      await h.get(InteractionChannelService).configure(owner(1), 'telegram', { mode: 'own', token: BOT_TOKEN });
      const provider = h.get(TelegramChannelProvider);
      const links = h.get(TelegramLinkService);
      const { code } = await provider.linkCode(owner(1));
      const start = { telegramUserId: TG_ACCOUNT, chatId: TG_ACCOUNT, code, label: null, languageCode: null };
      const outcomes = await Promise.all(Array.from({ length: 10 }, () => links.consume('u1', start)));
      expect(outcomes.filter((outcome) => outcome === 'linked')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'invalid')).toHaveLength(9);
      const expired = await provider.linkCode(owner(1));
      await h.dataSource.getRepository(InteractionLinkCodeEntity).update({ usedAt: IsNull() }, { expiresAt: new Date(Date.now() - 1000) });
      expect(await links.consume('u1', { ...start, telegramUserId: '555', chatId: '555', code: expired.code })).toBe('invalid');
      h.telegram.addBot(BOT_TOKEN_2, '7000002', 'bot_of_2');
      await h.get(InteractionChannelService).configure(owner(2), 'telegram', { mode: 'own', token: BOT_TOKEN_2 });
      const second = await provider.linkCode(owner(2));
      expect(await links.consume('u2', { ...start, code: second.code })).toBe('conflict');
    });

    it('16. network guard: private IP, name resolved to a private IP at send time, redirect, HTTP for a non-admin', async () => {
      const publicThenPrivate: AddressGuard = { allowPrivate: false, isBlocked: isBlockedAddress, resolve: async () => [{ address: '127.0.0.1', family: 4 }] };
      await expect(guardedRequest(new URL('https://10.0.0.5/hook'), { method: 'POST', body: '{}', timeoutMs: 2000 }, publicThenPrivate)).rejects.toMatchObject({ code: 'ADDRESS_REFUSED' });
      await expect(guardedRequest(new URL('https://169.254.169.254/latest'), { method: 'GET', timeoutMs: 2000 }, publicThenPrivate)).rejects.toMatchObject({ code: 'ADDRESS_REFUSED' });
      await expect(guardedRequest(new URL('https://hooks.example.test/x'), { method: 'POST', body: '{}', timeoutMs: 2000 }, publicThenPrivate)).rejects.toMatchObject({ code: 'ADDRESS_REFUSED' });
      expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
      expect(isBlockedAddress('64:ff9b::a00:1')).toBe(true);
      expect(isBlockedAddress('2002:0a00:0001::')).toBe(true);
      expect(isBlockedAddress('93.184.216.34')).toBe(false);
      const server: Server = createServer((_req, res) => {
        res.writeHead(302, { Location: 'http://169.254.169.254/' });
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const admin: AddressGuard = { allowPrivate: true, isBlocked: isBlockedAddress, resolve: async () => [{ address: '127.0.0.1', family: 4 }] };
        await expect(guardedRequest(new URL(`http://hooks.local.test:${port}/x`), { method: 'POST', body: '{}', timeoutMs: 2000 }, admin)).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      expect(() => validateTargetUrl('http://hooks.example.test/x', { admin: false })).toThrow(NetGuardError);
      expect(() => validateTargetUrl('http://hooks.example.test/x', { admin: false })).toThrow('HTTPS_REQUIRED');
      expect(validateTargetUrl('http://hooks.example.test/x', { admin: true }).protocol).toBe('http:');
      expect(() => validateTargetUrl('https://user:pw@hooks.example.test/x', { admin: true })).toThrow('CREDENTIALS_IN_URL');
      const sender = new (class extends WebPushSender {
        protected override guard(): AddressGuard {
          return publicThenPrivate;
        }
      })();
      const vapid = { subject: 'mailto:a@b.test', publicKey: 'x', privateKey: 'y' };
      expect(await sender.send({ endpoint: 'https://169.254.169.254/push', p256dh: 'a', auth: 'b' }, '{}', vapid, 1000)).toMatchObject({ ok: false, code: 'ADDRESS_REFUSED' });
      expect(await sender.send({ endpoint: 'https://push.example.test/rebound', p256dh: 'a', auth: 'b' }, '{}', vapid, 1000)).toMatchObject({ ok: false, code: 'ADDRESS_REFUSED' });
    });

    it('17. caps of email codes, tests and link codes survive a restart; per-user delivery cap', async () => {
      const database = options.database('restart');
      const config = { interaction_testsPerUserHour: 2, interaction_linkCodesPerUserHour: 1, interaction_emailCodesPerUserHour: 1 };
      await h.close();
      h = await harness(config, { database });
      await linkOwnTelegram(h, 1);
      const test = () => http(h).post('/api/v1/interaction/me/channels/telegram/test').set('Authorization', 'Bearer user-1');
      expect((await test()).status).toBe(201);
      expect((await test()).status).toBe(201);
      const third = await test();
      expect([third.status, third.body.code, third.body.details?.cap]).toEqual([429, 'RATE_LIMITED', 'user']);
      expect(third.headers['retry-after']).toBe('3600');
      await h.get(InteractionSendQuotaService).take('email_code', { userId: 1, target: 'A@B.test' });
      await h.close();
      h = await harness(config, { database, keepData: true });
      h.telegram.addBot(BOT_TOKEN, '7000001', 'bot_of_1');
      expect((await test()).status).toBe(429);
      await expectCode(h.get(InteractionSendQuotaService).take('link_code', { userId: 1 }), 'RATE_LIMITED');
      await expectCode(h.get(InteractionSendQuotaService).take('email_code', { userId: 1, target: 'a@b.test' }), 'RATE_LIMITED');
      h.config.values.set('interaction_maxPerUserHour', 1);
      const service = h.get(UserInteractionService);
      const first = await service.notify(1, notice({ category: 'security' }));
      const second = await service.notify(1, notice({ category: 'security' }));
      expect(first.deliveries.find((d) => d.kind === 'telegram')?.status).toBe('sent');
      expect(second.deliveries.find((d) => d.kind === 'telegram')).toEqual({ kind: 'telegram', status: 'skipped', code: 'CAPPED' });
    });

    it('18. the ticket of another user answers exactly like an unknown id (404)', async () => {
      const ticket = await h.get(UserInteractionService).ask(1, question());
      const agent = http(h);
      const strip = (body: Record<string, unknown>) => ({ code: body.code, message: body.message, statusCode: body.statusCode });
      const foreign = await agent.get(`/api/v1/interaction/me/tickets/${ticket.id}`).set('Authorization', 'Bearer user-2');
      const unknown = await agent.get('/api/v1/interaction/me/tickets/00000000-0000-4000-8000-000000000000').set('Authorization', 'Bearer user-2');
      expect(foreign.status).toBe(404);
      expect(strip(foreign.body)).toEqual(strip(unknown.body));
      const answer = await agent.post(`/api/v1/interaction/me/tickets/${ticket.id}/answer`).set('Authorization', 'Bearer user-2').send({ actionId: 'approve' });
      expect([answer.status, answer.body.code]).toEqual([404, 'NOT_FOUND']);
      expect((await agent.get(`/api/v1/interaction/me/tickets/${ticket.id}`).set('Authorization', 'Bearer user-1')).status).toBe(200);
    });

    it('19. /me routes refuse the admin key, local trust, a service key and no session', async () => {
      const agent = http(h);
      const routes: Array<[string, string]> = [
        ['get', '/api/v1/interaction/me/channels'],
        ['get', '/api/v1/interaction/me/inbox'],
        ['put', '/api/v1/interaction/me/prefs'],
        ['post', '/api/v1/interaction/me/tickets/00000000-0000-4000-8000-000000000000/answer'],
        ['post', '/api/v1/interaction/me/channels/telegram/link-code'],
      ];
      for (const [method, path] of routes) {
        const call = (agent as unknown as Record<string, (p: string) => request.Test>)[method](path);
        expect((await call).status).toBe(401);
        for (const headers of [{ Authorization: 'Bearer admin-key' }, { Authorization: 'Bearer local' }, { 'X-API-Key': 'svc_key_123' }, { Authorization: 'Bearer nope' }]) {
          expect((await (agent as unknown as Record<string, (p: string) => request.Test>)[method](path).set(headers)).status).toBe(401);
        }
      }
      expect((await agent.get('/api/v1/admin/interaction/channels').set('Authorization', 'Bearer user-1')).status).toBe(401);
    });

    it('20. ask without an active recipient → INTERACTION_NO_HUMAN; freshProof without a step-up port → STEP_UP_UNAVAILABLE', async () => {
      const service = h.get(UserInteractionService);
      h.directory.users.get(1)!.active = false;
      await expectCode(service.ask([1, 404], question()), 'INTERACTION_NO_HUMAN');
      h.directory.users.get(1)!.active = true;
      await expectCode(service.ask(1, question({ freshProof: true })), 'STEP_UP_UNAVAILABLE');
      await expectCode(service.ask(1, question({ kind: 'nobody.handles' })), 'UNKNOWN_QUESTION_KIND');
      await h.close();
      h = await harness({}, { stepUp: true });
      await linkOwnTelegram(h, 1);
      const ticket = await h.get(UserInteractionService).ask(1, question({ freshProof: true, answerableFrom: ['inapp', 'telegram'] }));
      await idle(h);
      expect(h.telegram.sent().some((call) => (call.keyboard?.inline_keyboard ?? []).flat().some((button) => 'callback_data' in button))).toBe(false);
      const agent = http(h);
      const noProof = await agent.post(`/api/v1/interaction/me/tickets/${ticket.id}/answer`).set('Authorization', 'Bearer user-1').send({ actionId: 'approve' });
      expect([noProof.status, noProof.body.code]).toEqual([403, 'STEP_UP_REQUIRED']);
      const badProof = await agent.post(`/api/v1/interaction/me/tickets/${ticket.id}/answer`).set('Authorization', 'Bearer user-1').send({ actionId: 'approve', stepUpProof: 'ok:another-purpose' });
      expect(badProof.status).toBe(403);
      const good = await agent.post(`/api/v1/interaction/me/tickets/${ticket.id}/answer`).set('Authorization', 'Bearer user-1').send({ actionId: 'approve', stepUpProof: `ok:interaction.ticket:${ticket.id}` });
      expect([good.status, good.body.status, good.body.answeredVia]).toEqual([200, 'answered', 'inapp']);
    });

    it('21. realtime: another user receives nothing, and no frame carries the text of a notice', async () => {
      const mine = await h.listen({ id: 1, admin: false, kind: 'user' });
      const theirs = await h.listen({ id: 2, admin: false, kind: 'user' });
      await expect(h.listen({ id: 0, admin: true, kind: 'admin-token' })).rejects.toThrow();
      await h.get(UserInteractionService).notify(1, notice({ title: { raw: 'Very private title' }, body: { raw: 'Very private body' } }));
      await h.get(UserInteractionService).ask(1, question());
      await idle(h);
      const events = mine.filter((frame) => frame.name === 'event');
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(theirs.filter((frame) => frame.name === 'event')).toHaveLength(0);
      const text = JSON.stringify(mine);
      for (const leak of ['Very private', 'Approve the order', 'Buy 1 BTC']) expect(text).not.toContain(leak);
    });

    it('22. a secret unreadable with the current master key → SECRET_UNREADABLE, never the ciphertext as a token', async () => {
      const tg = await linkOwnTelegram(h, 1);
      const secrets = h.dataSource.getRepository(InteractionSecretEntity);
      const row = await secrets.findOneByOrFail({ ownerUserId: 1 });
      const previous = process.env.CRYPT_DB_MASTER_KEY;
      process.env.CRYPT_DB_MASTER_KEY = 'a1'.repeat(32);
      const otherKey = new CryptService();
      process.env.CRYPT_DB_MASTER_KEY = previous;
      const foreign = new CryptInteractionSecretStore(secrets, otherKey);
      await expectCode(foreign.reveal(row.id, 1), 'SECRET_UNREADABLE');
      await secrets.update({ id: row.id }, { ciphertext: otherKey.encryptForStorage(BOT_TOKEN, `interaction:secret:${row.id}`) });
      expect(await h.get(TelegramBotStateStore).tokenFor(tg.botRef)).toEqual({ code: 'SECRET_UNREADABLE' });
      await expectCode(h.get<InteractionSecretStore>(INTERACTION_SECRET_STORE).reveal(row.id, 2), 'NOT_FOUND');
      const report = await h.get(UserInteractionService).notify(1, notice());
      expect(report.deliveries.find((d) => d.kind === 'telegram')?.code).toBe('SECRET_UNREADABLE');
      expect(h.telegram.calls.filter((call) => call.method === 'sendMessage' && call.text === 'Hello there')).toHaveLength(0);
    });

    it('answers through HTTP, closes the other surfaces and leaves a trace when answered outside the app', async () => {
      const tg = await linkOwnTelegram(h, 1);
      const ticket = await h.get(UserInteractionService).ask(1, question());
      expect(ticket.deliveries[0].deliveries).toEqual([{ kind: 'inapp', status: 'sent', code: null }, { kind: 'telegram', status: 'queued', code: null }]);
      await idle(h);
      const inbox = await http(h).get('/api/v1/interaction/me/inbox').set('Authorization', 'Bearer user-1');
      expect(inbox.body.tickets.map((t: { id: string }) => t.id)).toEqual([ticket.id]);
      expect(inbox.body.unread).toBe(inbox.body.tickets.length + inbox.body.notices.length);
      const card = lastCard(h);
      await h.get(TelegramUpdateHandler).handle(tg.botRef, tg.token, pressUpdate(80, { account: tg.account, chatId: tg.account, messageId: card.messageId, data: card.data[0] }));
      await idle(h);
      const after = await http(h).get('/api/v1/interaction/me/inbox').set('Authorization', 'Bearer user-1');
      expect(after.body.tickets).toHaveLength(0);
      expect(after.body.notices.map((n: { type: string }) => n.type)).toContain('interaction.answered_elsewhere');
      const late = await http(h).post(`/api/v1/interaction/me/tickets/${ticket.id}/answer`).set('Authorization', 'Bearer user-1').send({ actionId: 'deny' });
      expect([late.status, late.body.code, late.body.details?.via]).toEqual([409, 'ALREADY_ANSWERED', 'telegram']);
      expect(() => new InteractionError('NOT_FOUND')).not.toThrow();
    });
  });
}
