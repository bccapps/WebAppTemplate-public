/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Test doubles of the conformance testkit: an app directory, a Telegram Bot API that never leaves the process, a Web
// Push sender, and the few `common` services the module reads (configuration, locales, brand, cron lock, role).
// Nothing here makes a network call.

import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { interactionDefault } from '../interactionConfigSchema';
import type { TelegramBotIdentity, TelegramCallResult, TelegramInlineKeyboard } from '../providers/telegram/TelegramBotClient';
import type { WebPushResult, WebPushTarget } from '../providers/browser/WebPushSender';
import type { AuthPort } from '../../common/auth/AuthPort';
import type { AuthPrincipal } from '../../common/auth/AuthPrincipal';
import type { InteractionDirectory } from '../types/ports';

/** The app's users as the module sees them. */
@Injectable()
export class TestDirectory implements InteractionDirectory {
  readonly users = new Map<number, { active: boolean; admin: boolean; name: string; locale: string | null }>();

  add(id: number, patch: Partial<{ active: boolean; admin: boolean; name: string; locale: string | null }> = {}): void {
    this.users.set(id, { active: true, admin: false, name: `User ${id}`, locale: 'en', ...patch });
  }

  async isActive(userId: number): Promise<boolean> {
    return this.users.get(userId)?.active === true;
  }

  async isAdmin(userId: number): Promise<boolean> {
    return this.users.get(userId)?.admin === true;
  }

  async adminUserIds(): Promise<number[]> {
    return [...this.users.entries()].filter(([, user]) => user.admin && user.active).map(([id]) => id);
  }

  async displayNames(userIds: number[]): Promise<Map<number, string>> {
    return new Map(userIds.filter((id) => this.users.has(id)).map((id) => [id, this.users.get(id)?.name ?? '']));
  }

  async localeOf(userId: number): Promise<string | null> {
    return this.users.get(userId)?.locale ?? null;
  }
}

export interface FakeTelegramCall {
  method: string;
  botId: string;
  chatId?: string;
  messageId?: string;
  text?: string;
  keyboard?: TelegramInlineKeyboard;
  callbackId?: string;
}

/** A Bot API in memory: bots by token, sent messages, queued updates, recorded calls (the token is never recorded). */
@Injectable()
export class FakeTelegramBotClient {
  readonly bots = new Map<string, TelegramBotIdentity>();
  readonly calls: FakeTelegramCall[] = [];
  readonly updates = new Map<string, unknown[]>();
  /** Calls that fail (method → HTTP status), e.g. `sendMessage: 403`. */
  readonly failures = new Map<string, number>();
  /** Methods that never answer (to test timeouts). */
  readonly hang = new Set<string>();
  private nextMessageId = 100;

  addBot(token: string, id: string, username: string): void {
    this.bots.set(token, { id, username });
  }

  private botId(token: string): string {
    return token.split(':')[0];
  }

  private async gate<T>(method: string, token: string, ok: () => T): Promise<TelegramCallResult<T>> {
    if (this.hang.has(method)) await new Promise(() => undefined);
    if (!this.bots.has(token)) return { ok: false, status: 401 };
    const status = this.failures.get(method);
    if (status) return { ok: false, status };
    return { ok: true, result: ok() };
  }

  async getUpdates(token: string, offset: string | null): Promise<TelegramCallResult<unknown[]>> {
    this.calls.push({ method: 'getUpdates', botId: this.botId(token) });
    return this.gate('getUpdates', token, () => {
      const queued = this.updates.get(token) ?? [];
      const from = offset ? Number(offset) : 0;
      return queued.filter((update) => ((update as { update_id: number }).update_id ?? 0) >= from);
    });
  }

  async sendMessage(token: string, chatId: string, text: string, keyboard?: TelegramInlineKeyboard): Promise<TelegramCallResult<{ messageId: string | null }>> {
    return this.gate('sendMessage', token, () => {
      const messageId = String(this.nextMessageId++);
      this.calls.push({ method: 'sendMessage', botId: this.botId(token), chatId, messageId, text, keyboard });
      return { messageId };
    });
  }

  async editMessageText(token: string, chatId: string, messageId: string, text: string): Promise<TelegramCallResult<true>> {
    this.calls.push({ method: 'editMessageText', botId: this.botId(token), chatId, messageId, text });
    return this.gate('editMessageText', token, () => true as const);
  }

  async answerCallbackQuery(token: string, callbackId: string, text: string | null): Promise<TelegramCallResult<true>> {
    this.calls.push({ method: 'answerCallbackQuery', botId: this.botId(token), callbackId, text: text ?? '' });
    return this.gate('answerCallbackQuery', token, () => true as const);
  }

  async getMe(token: string): Promise<TelegramCallResult<TelegramBotIdentity>> {
    this.calls.push({ method: 'getMe', botId: this.botId(token) });
    return this.gate('getMe', token, () => this.bots.get(token) as TelegramBotIdentity);
  }

  async setWebhook(token: string): Promise<TelegramCallResult<true>> {
    this.calls.push({ method: 'setWebhook', botId: this.botId(token) });
    return this.gate('setWebhook', token, () => true as const);
  }

  async deleteWebhook(token: string): Promise<TelegramCallResult<true>> {
    this.calls.push({ method: 'deleteWebhook', botId: this.botId(token) });
    return this.gate('deleteWebhook', token, () => true as const);
  }

  sent(method = 'sendMessage'): FakeTelegramCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

/** Web Push in memory: what was sent to which endpoint (and the VAPID `sub` used), per-endpoint answers (404 / 410 remove the subscription). */
@Injectable()
export class FakeWebPushSender {
  readonly sent: Array<{ endpoint: string; payload: string; subject: string | null }> = [];
  readonly answers = new Map<string, WebPushResult>();

  async send(target: WebPushTarget, payload: string, vapid?: { subject: string }): Promise<WebPushResult> {
    const answer = this.answers.get(target.endpoint);
    if (answer) return answer;
    this.sent.push({ endpoint: target.endpoint, payload, subject: vapid?.subject ?? null });
    return { ok: true, status: 201, code: null };
  }
}

/** `ModuleConfigService` as the module uses it: values (parsed), secrets (clear, as `getDecryptedSecretValue` returns them). */
export class TestModuleConfig {
  readonly values = new Map<string, unknown>();
  readonly secrets = new Map<string, string>();
  readonly writes: string[] = [];

  register(): void {
    /* the schema is read from the file in tests */
  }

  getResolvedValue(key: string): unknown {
    return this.values.has(key) ? this.values.get(key) : interactionDefault(key);
  }

  getDecryptedValue(key: string): unknown {
    return this.getResolvedValue(key);
  }

  getDecryptedSecretValue(_moduleId: string, key: string): string | null {
    return this.secrets.get(key) ?? '';
  }

  async updateModuleConfig(_moduleId: string, values: Record<string, unknown>): Promise<null> {
    for (const [key, value] of Object.entries(values)) {
      this.writes.push(key);
      if (/(PrivateKey|Token)$/.test(key)) this.secrets.set(key, String(value));
      else this.values.set(key, value);
    }
    return null;
  }
}

/** `ConfigurationService.get` / `getConfiguration`. */
export class TestConfiguration {
  constructor(private readonly config: TestModuleConfig) {}

  get(key: string): unknown {
    return key === 'localeDefault' ? 'en' : this.config.values.get(key);
  }

  async getConfiguration(): Promise<unknown[]> {
    return [];
  }
}

/** `LocaleService.translate` over the module's own locale files. */
export class TestLocales {
  private readonly files = new Map<string, Record<string, string>>();

  async translate(key: string, lang: string): Promise<string> {
    const dictionary = this.dictionary(lang === 'fr' ? 'fr' : 'en');
    return dictionary[key] ?? key;
  }

  private dictionary(lang: string): Record<string, string> {
    let dictionary = this.files.get(lang);
    if (!dictionary) {
      dictionary = JSON.parse(readFileSync(join(__dirname, '..', 'locales', `interaction.${lang}.json`), 'utf8')) as Record<string, string>;
      this.files.set(lang, dictionary);
    }
    return dictionary;
  }
}

export class TestBrand {
  site = 'https://app.test';

  getSiteUrl(): string {
    return this.site;
  }

  getApiUrl(): string {
    return this.site;
  }

  absoluteUrl(path: string): string {
    return this.site ? `${this.site}/${String(path ?? '').replace(/^\/+/, '')}` : '';
  }

  apiAbsoluteUrl(path: string): string {
    return this.absoluteUrl(path);
  }
}

/** `CronLockService` of one process: runs the callback (the database lease is `common`'s own concern). */
export class TestCronLock {
  async runExclusive(_key: string, callback: () => Promise<void>): Promise<boolean> {
    await callback();
    return true;
  }

  async runIfDue(_key: string, _intervalMs: number, callback: () => Promise<void>): Promise<boolean> {
    await callback();
    return true;
  }
}

export class TestInstanceRole {
  isWorker(): boolean {
    return true;
  }

  isApi(): boolean {
    return true;
  }
}

/**
 * Bearer tokens of the HTTP tests, shaped as the `user` module issues its principals (lot S): `user-<id>` (a user
 * session: `isHumanSession`), `admin-user-<id>` (an administrator's session: `isHumanSession`), `api-user-<id>` (a user
 * API token: `isApiToken`), `bare-user-<id>` (a `user` principal carrying neither flag: what an `AuthPort` that does not
 * mark its sessions yet gives), `admin-key` (`ADMIN_TOKEN`), `local` (local trust). Anything else is refused.
 */
@Injectable()
export class TestAuthPort implements AuthPort {
  readonly mode = 'users' as const;

  async resolveToken(token: string): Promise<AuthPrincipal | null> {
    const user = /^user-(\d+)$/.exec(token);
    if (user) return { id: Number(user[1]), admin: false, kind: 'user', isHumanSession: true };
    const apiToken = /^api-user-(\d+)$/.exec(token);
    if (apiToken) return { id: Number(apiToken[1]), admin: false, kind: 'user', isApiToken: true };
    const bare = /^bare-user-(\d+)$/.exec(token);
    if (bare) return { id: Number(bare[1]), admin: false, kind: 'user' };
    const admin = /^admin-user-(\d+)$/.exec(token);
    if (admin) return { id: Number(admin[1]), admin: true, kind: 'user', isHumanSession: true };
    if (token === 'admin-key') return { id: 0, admin: true, kind: 'admin-token' };
    if (token === 'local') return { id: 0, admin: true, kind: 'local-trust' };
    return null;
  }
}
