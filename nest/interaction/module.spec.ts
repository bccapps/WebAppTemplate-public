/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Plugin factory, locale files, masking, network guard, Telegram client, derived keys, VAPID keys. No database. */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PluginOptionsError, pluginModules } from '../common/plugins/resolvePlugins';
import { resetThrottleBuckets } from '../common/utils/throttledFetch';
import { generateVapidKeys, vapidPublicKeyOf } from './adapters/ConfigVapidKeySource';
import { interactionConfigSchema } from './interactionConfigSchema';
import { InteractionModule } from './InteractionModule';
import { plugin } from './plugin';
import { TelegramBotClient } from './providers/telegram/TelegramBotClient';
import { InteractionKeyService } from './services/InteractionKeyService';
import { maskKnownSecrets } from './utils/maskKnownSecrets';
import { assertReachable, isBlockedAddress, NetGuardError, validateTargetUrl } from './utils/netGuard';

class Directory {
  async isActive(): Promise<boolean> {
    return true;
  }
  async isAdmin(): Promise<boolean> {
    return false;
  }
  async adminUserIds(): Promise<number[]> {
    return [];
  }
  async displayNames(): Promise<Map<number, string>> {
    return new Map();
  }
}

describe('plugin', () => {
  it('is a factory that requires the directory', () => {
    expect(() => pluginModules(plugin, {})).toThrow(PluginOptionsError);
    expect(() => pluginModules(plugin, { interaction: {} })).toThrow(/missing: directory/);
    const [module] = pluginModules(plugin, { interaction: { directory: Directory } }) as Array<{ module: unknown; global: boolean; controllers: unknown[] }>;
    expect(module.module).toBe(InteractionModule);
    expect(module.global).toBe(true);
    expect(module.controllers).toHaveLength(2);
    expect(pluginModules(plugin, { interaction: false })).toEqual([]);
  });

  it('turns the routes on and off', () => {
    const none = InteractionModule.forRoot({ directory: Directory, routes: { user: false, admin: false } });
    expect(none.controllers).toHaveLength(0);
    const webhook = InteractionModule.forRoot({ directory: Directory, routes: { telegramWebhook: true } });
    expect(webhook.controllers).toHaveLength(3);
  });
});

describe('locales and configuration', () => {
  const read = (lang: string) => JSON.parse(readFileSync(join(__dirname, 'locales', `interaction.${lang}.json`), 'utf8')) as Record<string, string>;

  it('en and fr have the same keys, every config field and option is labelled', () => {
    const en = read('en');
    const fr = read('fr');
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    for (const field of interactionConfigSchema.fields) {
      expect(en[field.label]).toBeDefined();
      expect(en[field.description as string]).toBeDefined();
      for (const option of field.options ?? []) expect(en[option.label]).toBeDefined();
    }
    expect(en[interactionConfigSchema.moduleName]).toBeDefined();
    for (const key of interactionConfigSchema.fields.map((f) => f.key)) expect(key).toMatch(/^interaction_[a-zA-Z]+$/);
  });

  it('every server key used in the code exists', () => {
    const en = read('en');
    const sources = ['services/InteractionTicketService.ts', 'services/UserInteractionService.ts', 'services/InteractionDeliveryService.ts', 'providers/telegram/TelegramChannelProvider.ts', 'providers/telegram/TelegramUpdateHandler.ts', 'providers/browser/BrowserChannelProvider.ts'];
    const used = new Set<string>();
    for (const file of sources) for (const match of readFileSync(join(__dirname, file), 'utf8').matchAll(/'(interaction\.server\.[A-Za-z_.]+)'/g)) used.add(match[1]);
    expect(used.size).toBeGreaterThan(10);
    for (const key of used) expect(en[key]).toBeDefined();
    for (const outcome of ['answered', 'expired', 'cancelled']) expect(en[`interaction.server.telegram.card.${outcome}`]).toBeDefined();
    for (const outcome of ['linked', 'already_linked', 'conflict', 'limit', 'invalid']) expect(en[`interaction.server.telegram.link.${outcome}`]).toBeDefined();
  });
});

describe('maskKnownSecrets', () => {
  it('masks keys, tokens, bot tokens, webhook keys and JWTs', () => {
    const text = [
      'sk-ant-abcdefghijklmnopqrstuvwxyz',
      '123456789:AAHabcdefghijklmnopqrstuvwxyz012345',
      'whsec_abcdefghijklmnopqrstuv',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      // A fake JWT assembled at runtime: a literal one would trip the repository secret scan (gitleaks `jwt` rule).
      ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NSJ9', 'abcdefghijklmnop'].join('.'),
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    ].join(' ');
    const masked = maskKnownSecrets(text);
    expect(masked).not.toMatch(/abcdefghijklmnop/);
    expect(masked).toContain('Bearer [secret hidden]');
    expect(maskKnownSecrets('order 12 of 3 BTC')).toBe('order 12 of 3 BTC');
  });
});

describe('network guard', () => {
  it('blocks private, loopback, link-local, NAT64 / 6to4 of private ranges, not public ones', () => {
    for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00:ec2::254', 'fe80::1', '::ffff:192.168.1.1', '64:ff9b::7f00:1', '2002:7f00:0001::', 'not-an-ip']) expect(isBlockedAddress(address)).toBe(true);
    for (const address of ['1.1.1.1', '2606:4700:4700::1111']) expect(isBlockedAddress(address)).toBe(false);
  });

  it('judges a URL now: literal IP, then the resolution of a name (no host in the error)', async () => {
    const guard = { allowPrivate: false, isBlocked: isBlockedAddress, resolve: async () => [{ address: '192.168.0.10', family: 4 }] };
    await expect(assertReachable(new URL('https://192.168.0.1/'), guard)).rejects.toThrow(NetGuardError);
    await expect(assertReachable(new URL('https://intranet.test/'), guard)).rejects.toThrow('ADDRESS_REFUSED');
    await expect(assertReachable(new URL('https://intranet.test/'), { ...guard, allowPrivate: true })).resolves.toBeUndefined();
    await expect(assertReachable(new URL('https://public.test/'), { ...guard, resolve: async () => [{ address: '1.1.1.1', family: 4 }] })).resolves.toBeUndefined();
    expect(() => validateTargetUrl('ftp://x.test', { admin: true })).toThrow('HTTPS_REQUIRED');
  });
});

describe('TelegramBotClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetThrottleBuckets();
  });

  it('posts plain text to the Bot API and never logs the token', async () => {
    const token = '424242:SECRET_part_of_the_token_0123456789';
    const calls: Array<{ url: string; body: unknown }> = [];
    const warnings: string[] = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => void warnings.push(String(message)));
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      if (String(input).endsWith('/getMe')) return new Response(JSON.stringify({ ok: true, result: { id: 424242, is_bot: true, username: 'my_bot' } }), { status: 200 });
      if (String(input).endsWith('/sendMessage')) return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
      return new Response('{}', { status: 503 });
    });
    const client = new TelegramBotClient();
    expect(await client.getMe(token)).toEqual({ ok: true, result: { id: '424242', username: 'my_bot' } });
    expect(await client.sendMessage(token, '42', '<b>not html</b>')).toEqual({ ok: true, result: { messageId: '7' } });
    expect(calls[1].body).toEqual({ chat_id: '42', text: '<b>not html</b>', disable_web_page_preview: true });
    expect(await client.answerCallbackQuery(token, 'q1', 'x')).toEqual({ ok: false, status: 503 });
    expect(await client.sendMessage('not a token', '42', 'x')).toEqual({ ok: false, status: 401 });
    expect(await client.sendMessage(token, '42', 'x', { inline_keyboard: [[{ text: 'a', callback_data: 'x'.repeat(65) }]] })).toEqual({ ok: false, status: 400 });
    expect(warnings.join('\n')).not.toContain('SECRET_part');
  });
});

describe('derived keys and VAPID keys', () => {
  it('derives stable, purpose-bound keys from the master key', () => {
    const saved = process.env.CRYPT_DB_MASTER_KEY;
    process.env.CRYPT_DB_MASTER_KEY = '11'.repeat(32);
    const a = new InteractionKeyService();
    const b = new InteractionKeyService();
    process.env.CRYPT_DB_MASTER_KEY = '22'.repeat(32);
    const other = new InteractionKeyService();
    process.env.CRYPT_DB_MASTER_KEY = '';
    expect(() => new InteractionKeyService()).toThrow(/CRYPT_DB_MASTER_KEY/);
    process.env.CRYPT_DB_MASTER_KEY = saved;
    expect(a.callbackKey().equals(b.callbackKey())).toBe(true);
    expect(a.callbackKey().equals(other.callbackKey())).toBe(false);
    expect(a.webhookSecret('u1', '7')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.webhookSecret('u1', '7')).not.toBe(a.webhookSecret('u2', '7'));
    expect(a.webhookSecret('u1', '7')).not.toBe(a.webhookSecret('u1', '8'));
  });

  it('generates P-256 VAPID keys whose public half is derived from the private one', () => {
    const pair = generateVapidKeys();
    expect(pair.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(pair.publicKey, 'base64url')).toHaveLength(65);
    expect(vapidPublicKeyOf(pair.privateKey)).toBe(pair.publicKey);
  });
});
