/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// The Bot API calls of the module (extracted from AgentHub `telegram/TelegramBotClient.ts`, without its file and voice
// methods), through `throttledFetchJson` (template rule: no raw fetch to a third party). Messages are PLAIN TEXT (no
// `parse_mode`: an app's summary is never interpreted as markup). The token is part of the URL: it is checked against
// the Bot API's shape before any call (a URL that fails to parse would put it in an error message), the throttle buckets
// are named by the bot's public id, and nothing here logs a token, a chat or a text. `throttledFetchJson` logs the
// message of a failed fetch: every call goes through `botApiTransport`, which replaces whatever `fetch` throws (an undici
// error, a polyfill's error quoting the URL, an abort) by a code. `apiBase()` is the seam tests replace.

import { Injectable } from '@nestjs/common';
import { throttledFetchJson, type ThrottledFetchResult, type ThrottledFetchTransport } from '../../../common/utils/throttledFetch';
import { botIdOf, isBotToken } from '../../pure/telegramUpdate';

const API_BASE = 'https://api.telegram.org';
/** Seconds Telegram holds a `getUpdates` call open when nothing comes. */
export const TELEGRAM_POLL_TIMEOUT_SEC = 25;
/** One message per second in a chat (Bot FAQ): the sends of a bot are spaced by this much. */
const SEND_SPACING_MS = 1_100;
export const TELEGRAM_ALLOWED_UPDATES = ['message', 'callback_query'] as const;
export const CALLBACK_DATA_MAX_BYTES = 64;
const CALLBACK_ANSWER_MAX_CHARS = 200;

export type TelegramCallResult<T> = { ok: true; result: T } | { ok: false; status: number };

/** A button: `callback_data` (pressed → sent back to the bot) or `url` (opens a link, here: the app). */
export type TelegramInlineButton = { text: string; callback_data: string } | { text: string; url: string };

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

export interface TelegramBotIdentity {
  id: string;
  username: string | null;
}

interface BotApiEnvelope<T> {
  ok?: boolean;
  result?: T;
}

/** A keyboard the Bot API accepts: labelled buttons, `callback_data` 1-64 bytes or an `https` URL, 20 buttons at most. */
export function isInlineKeyboard(markup: TelegramInlineKeyboard): boolean {
  if (!markup || !Array.isArray(markup.inline_keyboard) || !markup.inline_keyboard.every((row) => Array.isArray(row))) return false;
  const buttons = markup.inline_keyboard.flat();
  if (buttons.length > 20) return false;
  return buttons.every((button) => {
    if (typeof button.text !== 'string' || button.text.trim() === '' || button.text.length > 64) return false;
    if ('url' in button) return typeof button.url === 'string' && /^https?:\/\//.test(button.url) && button.url.length <= 512;
    const bytes = typeof button.callback_data === 'string' ? Buffer.byteLength(button.callback_data, 'utf8') : 0;
    return bytes >= 1 && bytes <= CALLBACK_DATA_MAX_BYTES;
  });
}

function isMessageId(value: string): boolean {
  return /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}

function failedStatus(response: ThrottledFetchResult<unknown>): number {
  return response.data === null ? response.status : 502;
}

/** What a failed Bot API transport throws: its message is a code, never the URL (which holds the token) nor a body. */
export class BotApiTransportError extends Error {
  constructor(readonly code: 'TIMEOUT' | 'NETWORK') {
    super(code);
    this.name = 'BotApiTransportError';
  }
}

/**
 * The transport of every Bot API call (the module boundary, 04 §13): `fetch` with the call's `init`, the body read as
 * JSON (null when it is not JSON), and ANY error of `fetch` or of the body (network, DNS, TLS, abort, a polyfill quoting
 * the URL) replaced by a `BotApiTransportError` with a code. `throttledFetchJson` logs that message: a code only.
 */
export function botApiTransport(init: RequestInit): ThrottledFetchTransport {
  return async (url, signal) => {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal, headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) } });
    } catch {
      throw new BotApiTransportError(signal.aborted ? 'TIMEOUT' : 'NETWORK');
    }
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      if (signal.aborted) throw new BotApiTransportError('TIMEOUT');
      body = null;
    }
    return { status: response.status, body, retryAfter: response.headers?.get('retry-after') ?? null };
  };
}

@Injectable()
export class TelegramBotClient {
  /** The Bot API base URL (tests point it at a fake server). */
  protected apiBase(): string {
    return API_BASE;
  }

  /** A POST of `body` as JSON, through the sanitizing transport (never `init`: `throttledFetchJson`'s own fetch would log raw errors). */
  private post(body: Record<string, unknown>): { transport: ThrottledFetchTransport } {
    return { transport: botApiTransport({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
  }

  private url(token: string, method: string): string {
    return `${this.apiBase()}/bot${token}/${method}`;
  }

  /** Long poll after `offset` (messages and button presses). */
  async getUpdates(token: string, offset: string | null): Promise<TelegramCallResult<unknown[]>> {
    if (!isBotToken(token)) return { ok: false, status: 401 };
    const body = { timeout: TELEGRAM_POLL_TIMEOUT_SEC, allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], ...(offset ? { offset: Number(offset) } : {}) };
    const response = await throttledFetchJson<BotApiEnvelope<unknown[]>>(`interaction-telegram-getUpdates:${botIdOf(token)}`, this.url(token, 'getUpdates'), {
      timeoutMs: (TELEGRAM_POLL_TIMEOUT_SEC + 15) * 1000,
      maxRetries: 0,
      ...this.post(body),
    });
    if (response.data?.ok !== true || !Array.isArray(response.data.result)) return { ok: false, status: failedStatus(response) };
    return { ok: true, result: response.data.result };
  }

  /** One plain-text message, spaced from the previous send of the bot; `replyMarkup`: its inline keyboard. */
  async sendMessage(token: string, chatId: string, text: string, replyMarkup?: TelegramInlineKeyboard): Promise<TelegramCallResult<{ messageId: string | null }>> {
    if (!isBotToken(token)) return { ok: false, status: 401 };
    if (replyMarkup && !isInlineKeyboard(replyMarkup)) return { ok: false, status: 400 };
    const response = await throttledFetchJson<BotApiEnvelope<{ message_id?: number }>>(`interaction-telegram-send:${botIdOf(token)}`, this.url(token, 'sendMessage'), {
      timeoutMs: 15_000,
      maxRetries: 2,
      minIntervalMs: SEND_SPACING_MS,
      ...this.post({ chat_id: chatId, text, disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
    });
    if (response.data?.ok !== true) return { ok: false, status: failedStatus(response) };
    const id = response.data.result?.message_id;
    return { ok: true, result: { messageId: typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : null } };
  }

  /** Redraws a message the bot sent (plain text); `replyMarkup` absent = no buttons any more. */
  async editMessageText(token: string, chatId: string, messageId: string, text: string, replyMarkup?: TelegramInlineKeyboard): Promise<TelegramCallResult<true>> {
    if (!isBotToken(token)) return { ok: false, status: 401 };
    if (!isMessageId(messageId) || (replyMarkup && !isInlineKeyboard(replyMarkup))) return { ok: false, status: 400 };
    const body = { chat_id: chatId, message_id: Number(messageId), text, disable_web_page_preview: true, reply_markup: replyMarkup ?? { inline_keyboard: [] } };
    const response = await throttledFetchJson<BotApiEnvelope<unknown>>(`interaction-telegram-send:${botIdOf(token)}`, this.url(token, 'editMessageText'), {
      timeoutMs: 15_000,
      maxRetries: 1,
      minIntervalMs: SEND_SPACING_MS,
      ...this.post(body),
    });
    return response.data?.ok === true ? { ok: true, result: true } : { ok: false, status: failedStatus(response) };
  }

  /** Answers a pressed button (its progress bar stops); `text`: a short notice (200 characters at most). Not spaced. */
  async answerCallbackQuery(token: string, callbackQueryId: string, text: string | null): Promise<TelegramCallResult<true>> {
    if (!isBotToken(token)) return { ok: false, status: 401 };
    if (!/^[\x21-\x7e]{1,128}$/.test(callbackQueryId)) return { ok: false, status: 400 };
    const notice = text ? [...text].slice(0, CALLBACK_ANSWER_MAX_CHARS).join('') : '';
    const response = await throttledFetchJson<BotApiEnvelope<boolean>>(`interaction-telegram-answer:${botIdOf(token)}`, this.url(token, 'answerCallbackQuery'), {
      timeoutMs: 10_000,
      maxRetries: 1,
      ...this.post({ callback_query_id: callbackQueryId, ...(notice ? { text: notice } : {}) }),
    });
    return response.data?.ok === true ? { ok: true, result: true } : { ok: false, status: failedStatus(response) };
  }

  /** The bot behind a token: its public id and `@username`. */
  async getMe(token: string): Promise<TelegramCallResult<TelegramBotIdentity>> {
    if (!isBotToken(token)) return { ok: false, status: 401 };
    const response = await throttledFetchJson<BotApiEnvelope<{ id?: number; username?: string; is_bot?: boolean }>>(`interaction-telegram-getMe:${botIdOf(token)}`, this.url(token, 'getMe'), {
      timeoutMs: 15_000,
      maxRetries: 1,
      ...this.post({}),
    });
    const bot = response.data?.result;
    if (response.data?.ok !== true || !bot || typeof bot.id !== 'number' || bot.is_bot === false) return { ok: false, status: failedStatus(response) };
    const username = typeof bot.username === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(bot.username) ? bot.username : null;
    return { ok: true, result: { id: String(bot.id), username } };
  }

  /**
   * Webhook mode (04 §11.3): Telegram posts the updates to `url` with `secretToken` in `X-Telegram-Bot-Api-Secret-Token`,
   * one at a time (`max_connections: 1`: in order, so the route's monotonic `update_id` claim never refuses a late one).
   */
  async setWebhook(token: string, url: string, secretToken: string): Promise<TelegramCallResult<true>> {
    if (!isBotToken(token)) return { ok: false, status: 401 };
    if (!/^https:\/\//.test(url) || !/^[A-Za-z0-9_-]{1,256}$/.test(secretToken)) return { ok: false, status: 400 };
    const response = await throttledFetchJson<BotApiEnvelope<boolean>>(`interaction-telegram-webhook:${botIdOf(token)}`, this.url(token, 'setWebhook'), {
      timeoutMs: 15_000,
      maxRetries: 1,
      ...this.post({ url, secret_token: secretToken, max_connections: 1, allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], drop_pending_updates: false }),
    });
    return response.data?.ok === true ? { ok: true, result: true } : { ok: false, status: failedStatus(response) };
  }

  async deleteWebhook(token: string): Promise<TelegramCallResult<true>> {
    if (!isBotToken(token)) return { ok: false, status: 401 };
    const response = await throttledFetchJson<BotApiEnvelope<boolean>>(`interaction-telegram-webhook:${botIdOf(token)}`, this.url(token, 'deleteWebhook'), {
      timeoutMs: 15_000,
      maxRetries: 1,
      ...this.post({ drop_pending_updates: false }),
    });
    return response.data?.ok === true ? { ok: true, result: true } : { ok: false, status: failedStatus(response) };
  }
}
