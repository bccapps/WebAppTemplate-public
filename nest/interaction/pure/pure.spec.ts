/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { InteractionError } from '../errors/InteractionError';
import { parseAnswerBody, parseChannelState, parseKind, parsePrefBody, parseReadBody, parseUuid, parseWebPushSubscribe } from './bodies';
import { constantTimeEqual, hashCode, hashTarget, newLinkCode, sourceDedupKey, timeOrderedId } from './codes';
import { DEFAULT_PUSH_HOSTS, isAllowedPushEndpoint, pushHostPatterns } from './pushHosts';
import { compareChannels, planDelivery, quietHoursHoldBack, withinQuietHours, type PlanChannel, type PlanPrefs } from './deliveryPlan';
import { newCardKey, parseCallback, pressMatchesBinding, signCallback, verifyCallback } from './telegramCallback';
import { backoffMs, botIdOf, chunkForTelegram, classifyTelegramStatus, isBotRef, isBotToken, messageOf, pressOf, startCommandOf, userOfBotRef } from './telegramUpdate';
import { cleanText, fillParams, renderText, safeText, sanitizeRelativeUrl, sanitizeText, truncate } from './text';
import { answerableKinds, bringsFreshProof, normalizeRecipients, validateNotice, validateQuestion, type AnswerChannel } from './validation';

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof InteractionError ? `${error.code}${error.details?.field ? `:${error.details.field}` : ''}` : 'other';
  }
}

describe('text', () => {
  it('cleans control characters, masks secrets and cuts by code points', () => {
    expect(cleanText(' a\r\nb\u0007 ')).toBe('a\nb');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('😀😀😀', 2)).toBe('😀…');
    expect(safeText('token sk-abcdefghijklmnopqrstuvwxyz0123', 200)).toBe('token [secret hidden]');
    expect(safeText('bot 123456789:AAHabcdefghijklmnopqrstuvwxyz0123456789', 200)).toBe('bot [secret hidden]');
  });

  it('fills named parameters and leaves unknown ones visible', () => {
    expect(fillParams('Hi {name}, {missing}', { name: 'Ana' })).toBe('Hi Ana, {missing}');
  });

  it('sanitizes an InteractionText (raw or key + params) and refuses malformed ones', () => {
    expect(sanitizeText({ raw: '  hi  ' })).toEqual({ raw: 'hi' });
    expect(sanitizeText({ key: 'a.b', params: { n: 2, s: 'x' } })).toEqual({ key: 'a.b', params: { n: 2, s: 'x' } });
    expect(sanitizeText({ key: 'bad key!' })).toBeNull();
    expect(sanitizeText({ key: 'a.b', params: { n: { deep: 1 } } })).toBeNull();
    expect(sanitizeText({ raw: '' })).toBeNull();
    expect(sanitizeText('plain')).toBeNull();
  });

  it('renders a key through the translator then masks and cuts', async () => {
    const translate = async (key: string) => (key === 'k' ? 'Hello {who} Bearer abcdefghijklmnopqrstuvwxyz' : key);
    expect(await renderText({ key: 'k', params: { who: 'Bob' } }, translate, 100)).toBe('Hello Bob Bearer [secret hidden]');
    expect(await renderText({ raw: 'x'.repeat(10) }, translate, 5)).toBe('xxxx…');
  });

  it('accepts relative app paths only', () => {
    expect(sanitizeRelativeUrl('/a/b?c=1')).toBe('/a/b?c=1');
    for (const bad of ['https://x.test', '//evil.test', '/a\\b', 'a/b', '/\u0000']) expect(sanitizeRelativeUrl(bad)).toBeNull();
  });
});

describe('validation', () => {
  const notice = { type: 'mcp.credential.created', source: 'mcp-access', category: 'security' as const, title: { raw: 'T' } };

  it('validates a notice and applies defaults', () => {
    expect(validateNotice(notice)).toMatchObject({ priority: 'normal', body: null, url: null, dedupKey: null, data: null });
    expect(code(() => validateNotice({ ...notice, type: 'Bad' }))).toBe('INVALID_NOTICE:type');
    expect(code(() => validateNotice({ ...notice, url: 'https://evil.test' }))).toBe('INVALID_NOTICE:url');
    expect(code(() => validateNotice({ ...notice, dedupKey: 'x'.repeat(129) }))).toBe('INVALID_NOTICE:dedupKey');
    expect(code(() => validateNotice({ ...notice, data: { big: 'x'.repeat(300) } }))).toBe('INVALID_NOTICE:data');
    expect(code(() => validateNotice({ ...notice, data: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v'.repeat(250)])) }))).toBe('INVALID_NOTICE:data');
    expect(validateNotice({ ...notice, data: { ticketId: 'abc', n: 2, ok: true } }).data).toEqual({ ticketId: 'abc', n: 2, ok: true });
    expect(code(() => validateNotice({ ...notice, category: 'other' as never }))).toBe('INVALID_NOTICE:category');
  });

  const now = new Date('2026-11-10T10:00:00Z');
  const question = {
    kind: 'mcp.approval',
    source: 'mcp-access',
    correlationId: 'a1',
    category: 'approval' as const,
    summary: { title: { raw: 'Approve?' }, fields: [{ label: { raw: 'Amount' }, value: '10 USDC' }] },
    actions: [
      { id: 'approve', label: { raw: 'Yes' }, style: 'primary' as const },
      { id: 'deny', label: { raw: 'No' }, style: 'danger' as const },
    ],
    expiresAt: new Date(now.getTime() + 60_000),
  };

  it('validates a question: actions, expiry window, kinds', () => {
    expect(validateQuestion(question, { now, maxTtlSeconds: 3600 }).freshProof).toBe(false);
    expect(code(() => validateQuestion({ ...question, actions: question.actions.slice(0, 1) }, { now, maxTtlSeconds: 3600 }))).toBe('INVALID_QUESTION:actions');
    expect(code(() => validateQuestion({ ...question, actions: [question.actions[0], question.actions[0]] }, { now, maxTtlSeconds: 3600 }))).toBe('INVALID_QUESTION:actions');
    expect(code(() => validateQuestion({ ...question, expiresAt: now }, { now, maxTtlSeconds: 3600 }))).toBe('INVALID_QUESTION:expiresAt');
    expect(code(() => validateQuestion({ ...question, expiresAt: new Date(now.getTime() + 7200_000) }, { now, maxTtlSeconds: 3600 }))).toBe('INVALID_QUESTION:expiresAt');
    expect(code(() => validateQuestion({ ...question, answerableFrom: [] }, { now, maxTtlSeconds: 3600 }))).toBe('INVALID_QUESTION:answerableFrom');
    expect(code(() => validateQuestion({ ...question, summary: { title: { raw: 'x' }, body: { raw: 'y'.repeat(900) }, fields: Array.from({ length: 12 }, () => ({ label: { raw: 'l'.repeat(80) }, value: 'v'.repeat(200) })) } }, { now, maxTtlSeconds: 3600 }))).toBe('INVALID_QUESTION:summary');
  });

  it('computes the kinds that may answer from the declared capabilities (freshProof → `in_app` proof only, never empty)', () => {
    const builtIn: AnswerChannel[] = [
      { kind: 'inapp', reply: true, proof: 'in_app' },
      { kind: 'browser', reply: false, proof: 'link' },
      { kind: 'telegram', reply: true, proof: 'link' },
    ];
    expect(answerableKinds(null, builtIn, false)).toEqual(['inapp', 'telegram']);
    expect(answerableKinds(['telegram', 'browser'], builtIn, false)).toEqual(['telegram']);
    expect(answerableKinds(['inapp', 'telegram'], builtIn, true)).toEqual(['inapp']);
    expect(answerableKinds(null, builtIn, true)).toEqual(['inapp']);
    expect(answerableKinds(['telegram'], builtIn, true)).toEqual(['inapp']);
    expect(answerableKinds(['browser'], builtIn, false)).toEqual(['inapp']);
    // 04 §22: an app's in-app reply channel (AgentHub messaging) answers a freshProof question; a `code` one does not in v1.
    const withApp: AnswerChannel[] = [...builtIn, { kind: 'hubchat', reply: true, proof: 'in_app' }, { kind: 'otp', reply: true, proof: 'code' }];
    expect(answerableKinds(null, withApp, true)).toEqual(['inapp', 'hubchat']);
    expect(answerableKinds(['hubchat', 'telegram', 'otp'], withApp, true)).toEqual(['hubchat']);
    expect(answerableKinds(null, withApp, false)).toEqual(['inapp', 'telegram', 'hubchat', 'otp']);
    expect([bringsFreshProof('in_app'), bringsFreshProof('link'), bringsFreshProof('code'), bringsFreshProof(null)]).toEqual([true, false, false, false]);
  });

  it('normalizes recipients', () => {
    expect(normalizeRecipients([3, 3, 4], 20)).toEqual([3, 4]);
    expect(code(() => normalizeRecipients([], 20))).toBe('INVALID_QUESTION:recipients');
    expect(code(() => normalizeRecipients([0], 20))).toBe('INVALID_QUESTION:recipients');
  });
});

describe('delivery plan', () => {
  const prefs: PlanPrefs = { quietHoursStart: null, quietHoursEnd: null, timezone: 'UTC', criticalBypass: true, routing: null };
  const ch = (kind: string, extra: Partial<PlanChannel> = {}): PlanChannel => ({ kind, enabled: true, adminDisabled: false, position: 0, ready: true, notReadyCode: null, ...extra });
  const now = new Date('2026-11-10T23:30:00Z');

  it('handles quiet windows, including night windows and time zones', () => {
    expect(withinQuietHours({ start: '22:00', end: '07:00', timeZone: 'UTC' }, now)).toBe(true);
    expect(withinQuietHours({ start: '08:00', end: '20:00', timeZone: 'UTC' }, now)).toBe(false);
    expect(withinQuietHours({ start: '08:00', end: '20:00', timeZone: 'Asia/Tokyo' }, now)).toBe(true);
    expect(withinQuietHours({ start: '25:00', end: '07:00', timeZone: 'UTC' }, now)).toBe(false);
  });

  it('holds back info only, and lets critical through with the bypass', () => {
    const quiet = { ...prefs, quietHoursStart: '22:00', quietHoursEnd: '07:00' };
    expect(quietHoursHoldBack(quiet, 'info', 'normal', now)).toBe(true);
    expect(quietHoursHoldBack(quiet, 'info', 'critical', now)).toBe(false);
    expect(quietHoursHoldBack({ ...quiet, criticalBypass: false }, 'info', 'critical', now)).toBe(true);
    expect(quietHoursHoldBack(quiet, 'security', 'normal', now)).toBe(false);
    expect(quietHoursHoldBack(quiet, 'approval', 'normal', now)).toBe(false);
  });

  it('orders by position then the built-in order then alphabetically', () => {
    const sorted = [ch('zeta'), ch('webhook'), ch('telegram'), ch('alpha'), ch('browser', { position: 2 })].sort(compareChannels);
    expect(sorted.map((c) => c.kind)).toEqual(['telegram', 'webhook', 'alpha', 'zeta', 'browser']);
  });

  it('records why each configured channel is skipped', () => {
    const plan = planDelivery({
      category: 'info',
      priority: 'normal',
      enabledKinds: ['browser', 'telegram', 'webhook'],
      channels: [ch('browser', { enabled: false }), ch('telegram', { adminDisabled: true }), ch('webhook', { ready: false, notReadyCode: 'NOT_VERIFIED' }), ch('slack')],
      prefs,
      now,
    });
    expect(plan).toEqual([
      { kind: 'browser', send: false, code: 'DISABLED' },
      { kind: 'telegram', send: false, code: 'ADMIN_DISABLED' },
      { kind: 'webhook', send: false, code: 'NOT_VERIFIED' },
      { kind: 'slack', send: false, code: 'KIND_DISABLED' },
    ]);
  });

  it('never leaves approval / security silent when the route keeps no ready channel', () => {
    const input = { enabledKinds: ['browser', 'telegram'], channels: [ch('browser', { ready: false, notReadyCode: 'NO_SUBSCRIPTION' }), ch('telegram')], prefs: { ...prefs, routing: { security: ['browser'], info: ['browser'] } }, now, priority: 'normal' as const };
    expect(planDelivery({ ...input, category: 'security' }).find((e) => e.kind === 'telegram')).toEqual({ kind: 'telegram', send: true, code: null });
    expect(planDelivery({ ...input, category: 'info' }).find((e) => e.kind === 'telegram')).toEqual({ kind: 'telegram', send: false, code: 'ROUTED_OFF' });
    expect(planDelivery({ ...input, category: 'security', excludeKinds: ['telegram'] }).find((e) => e.kind === 'telegram')?.send).toBe(false);
  });
});

describe('codes', () => {
  it('link codes are 43 url-safe characters; hashes are SHA-256 hex; comparison is exact', () => {
    expect(newLinkCode()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashCode('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashTarget(' A@B.test ')).toBe(hashTarget('a@b.test'));
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual(undefined, 'a')).toBe(false);
  });

  it('time-ordered ids are uuids (v7 layout) sorted by creation, even within one millisecond and across a clock step back', () => {
    const ids = [...Array.from({ length: 50 }, () => timeOrderedId(1_000)), timeOrderedId(999), timeOrderedId(5_000)];
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('push hosts and dedup keys (review F8)', () => {
  it('accepts the major push services on their default port only; extra hosts are validated', () => {
    const hosts = pushHostPatterns(['push.example.test', '*.Corp.Example']);
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://web.push.apple.com/x', 'https://push.example.test/a', 'https://a.corp.example/x', 'https://FCM.googleapis.com./x']) expect([ok, isAllowedPushEndpoint(ok, hosts)]).toEqual([ok, true]);
    for (const no of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evilfcm.googleapis.com/x', 'https://push.apple.com/x', 'https://notify.windows.com/x', 'https://corp.example/x', 'https://u:p@fcm.googleapis.com/x', 'not a url', 'https://evil.example/fcm.googleapis.com']) expect([no, isAllowedPushEndpoint(no, hosts)]).toEqual([no, false]);
    expect(pushHostPatterns(undefined)).toEqual([...DEFAULT_PUSH_HOSTS]);
    for (const bad of ['', '*', '*.com.', 'http://x.example', 'a b.example', 'x.example/path', '**.example']) expect(() => pushHostPatterns([bad])).toThrow(/invalid push host/);
  });

  it('namespaces an app dedup key by its source, at a fixed width', () => {
    expect(sourceDedupKey('module-a', 'acct:42')).not.toBe(sourceDedupKey('mcp-access', 'acct:42'));
    expect(sourceDedupKey('mcp-access', 'acct:42')).toBe(sourceDedupKey('mcp-access', 'acct:42'));
    expect(sourceDedupKey('a', 'b\nc')).not.toBe(sourceDedupKey('a\nb', 'c'));
    expect(sourceDedupKey('x'.repeat(40), 'y'.repeat(128))).toMatch(/^n:[0-9a-f]{64}$/);
  });
});

describe('telegram callback', () => {
  const key = Buffer.alloc(32, 7);

  it('signs 26-byte callbacks bound to the bot, the card and the action', () => {
    const cardKey = newCardKey();
    expect(cardKey).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const data = signCallback(key, 'u1', cardKey, 2);
    expect(Buffer.byteLength(data)).toBe(26);
    const parsed = parseCallback(data);
    expect(parsed).toMatchObject({ cardKey, index: 2 });
    expect(verifyCallback(key, 'u1', parsed!)).toBe(true);
    expect(verifyCallback(key, 'u2', parsed!)).toBe(false);
    expect(verifyCallback(Buffer.alloc(32, 8), 'u1', parsed!)).toBe(false);
    expect(verifyCallback(key, 'u1', { ...parsed!, index: 1 })).toBe(false);
    expect(parseCallback('ix:short:0:abcdefgh')).toBeNull();
    expect(parseCallback(`${data}x`)).toBeNull();
    expect(() => signCallback(key, 'u1', cardKey, 4)).toThrow();
  });

  it('matches a press only on the whole binding', () => {
    const binding = { botRef: 'u1', chatId: '5', telegramUserId: '5', messageId: '9' };
    expect(pressMatchesBinding(binding, binding)).toBe(true);
    for (const field of Object.keys(binding)) expect(pressMatchesBinding(binding, { ...binding, [field]: 'other' })).toBe(false);
    expect(pressMatchesBinding({ ...binding, messageId: '' }, { ...binding, messageId: '' })).toBe(false);
    expect(pressMatchesBinding(null, binding)).toBe(false);
  });
});

describe('telegram updates', () => {
  const from = { id: 42, is_bot: false, username: 'ana', language_code: 'fr' };
  it('reads a press of a private chat, refuses bots, groups and malformed data', () => {
    const update = { update_id: 1, callback_query: { id: 'q1', from, message: { message_id: 7, chat: { id: 42, type: 'private' } }, data: 'ix:abc' } };
    expect(pressOf(update)).toEqual({ press: { callbackId: 'q1', telegramUserId: '42', chatId: '42', messageId: '7', data: 'ix:abc', languageCode: 'fr' } });
    expect(pressOf({ ...update, callback_query: { ...update.callback_query, from: { ...from, is_bot: true } } })).toEqual({ ignore: 'bot_sender', callbackId: 'q1' });
    expect(pressOf({ ...update, callback_query: { ...update.callback_query, message: { message_id: 7, chat: { id: -5, type: 'group' } } } })).toEqual({ ignore: 'not_private', callbackId: 'q1' });
    expect(pressOf({ update_id: 1, message: {} })).toBeNull();
  });

  it('reads /start <code> and messages of private chats only', () => {
    const code = 'A'.repeat(43);
    expect(startCommandOf({ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, from, text: `/start ${code}` } })).toMatchObject({ telegramUserId: '42', code, label: '@ana' });
    expect(startCommandOf({ update_id: 1, message: { message_id: 1, chat: { id: -1, type: 'group' }, from, text: `/start ${code}` } })).toBeNull();
    expect(startCommandOf({ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, from, text: '/start short' } })).toBeNull();
    expect(messageOf({ update_id: 1, message: { message_id: 3, chat: { id: 42, type: 'private' }, from, text: '/stop now' } })?.command).toEqual({ name: 'stop', arg: 'now' });
  });

  it('bot tokens, refs, statuses, backoff and chunks', () => {
    expect(isBotToken('123:abc_DEF-9')).toBe(true);
    expect(isBotToken('123:abc def')).toBe(false);
    expect(botIdOf('123:abc')).toBe('123');
    expect(userOfBotRef('u17')).toBe(17);
    expect(userOfBotRef('u0')).toBeNull();
    expect(isBotRef('telegram')).toBe(true);
    expect(isBotRef('x1')).toBe(false);
    expect(classifyTelegramStatus(409)).toBe('WEBHOOK_SET');
    expect(classifyTelegramStatus(0)).toBe('NETWORK');
    expect(backoffMs(1)).toBe(5000);
    expect(backoffMs(30)).toBe(15 * 60_000);
    expect(chunkForTelegram('a'.repeat(9000), 4000, 3).map((c) => c.length)).toEqual([4000, 4000, 1000]);
  });
});

describe('bodies', () => {
  it('parses the routes inputs and refuses the rest', () => {
    expect(parseChannelState({ enabled: false })).toEqual({ enabled: false });
    expect(code(() => parseChannelState({}))).toBe('INVALID_INPUT:body');
    expect(parseAnswerBody({ actionId: 'approve' })).toEqual({ actionId: 'approve', stepUpProof: null });
    expect(code(() => parseAnswerBody({ actionId: 'Approve' }))).toBe('INVALID_INPUT:actionId');
    expect(parseReadBody({ all: true })).toBe('all');
    expect(code(() => parseReadBody({ ids: ['x'] }))).toBe('INVALID_INPUT:ids');
    expect(code(() => parseUuid('nope'))).toBe('NOT_FOUND');
    expect(code(() => parseKind('inapp'))).toBe('NOT_FOUND');
    expect(code(() => parseWebPushSubscribe({ endpoint: 'http://push.test/x', keys: { p256dh: 'a', auth: 'b' } }))).toBe('INVALID_INPUT:endpoint');
    expect(parseWebPushSubscribe({ endpoint: 'https://push.test/x', keys: { p256dh: 'a', auth: 'b' } }).userAgent).toBeNull();
    const isZone = (zone: string) => zone === 'UTC';
    expect(code(() => parsePrefBody({ routing: { approval: [] } }, isZone))).toBe('ROUTE_REQUIRED');
    expect(code(() => parsePrefBody({ quietHours: { start: '22:00', end: '22:00' } }, isZone))).toBe('INVALID_INPUT:quietHours');
    expect(code(() => parsePrefBody({ timezone: 'Mars/Base' }, isZone))).toBe('INVALID_INPUT:timezone');
    expect(parsePrefBody({ routing: { info: [] }, inappDisplay: 'browser' }, isZone)).toEqual({ routing: { info: [] }, inappDisplay: 'browser' });
  });
});
