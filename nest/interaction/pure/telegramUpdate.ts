/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// The pure part of the Telegram inbound channel (extracted from AgentHub `telegram/telegramInboundPure.ts`): what an
// update is (a button press, a `/start <code>`, a message of a private chat), the wait after an error, the codes of a
// failed Bot API call, the cutting of a text. No I/O. Bot API facts: `callback_data` 1-64 bytes, `sendMessage` text
// 1-4096 characters, user ids 52 bits at most, private chat id = user id.

export const TELEGRAM_SEND_MAX_CHARS = 4000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const INBOUND_MAX_CHARS = 4000;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const CALLBACK_ID = /^[\x21-\x7e]{1,128}$/;
const CALLBACK_DATA = /^[\x21-\x7e]{1,64}$/;
const START_COMMAND = /^\/start(?:@[A-Za-z0-9_]{1,64})?\s+([A-Za-z0-9_-]{20,64})$/;
const BOT_COMMAND = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idString(value: unknown): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

/** The `update_id` of a raw update, null when absent. */
export function updateIdOf(update: unknown): number | null {
  const id = isRecord(update) ? update.update_id : undefined;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null;
}

/** `from.language_code` when it looks like a language tag, else null. */
export function languageCodeOf(from: unknown): string | null {
  const code = isRecord(from) ? from.language_code : undefined;
  return typeof code === 'string' && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})?$/.test(code) ? code : null;
}

/** A button press, reduced to what the binding check needs. */
export interface TelegramPress {
  callbackId: string;
  telegramUserId: string;
  chatId: string;
  messageId: string;
  data: string;
  languageCode: string | null;
}

/**
 * A `callback_query` judged: from a person (not a bot), on a message of a PRIVATE chat, with printable data. `null` when
 * the update is not a press; `{ ignore }` with the press id when it is malformed (it is still answered, generically).
 */
export function pressOf(update: unknown): { press: TelegramPress } | { ignore: string; callbackId: string | null } | null {
  if (!isRecord(update) || !('callback_query' in update)) return null;
  const query = update.callback_query;
  if (!isRecord(query) || typeof query.id !== 'string' || !CALLBACK_ID.test(query.id)) return { ignore: 'malformed', callbackId: null };
  const callbackId = query.id;
  const from = query.from;
  if (!isRecord(from) || from.is_bot === true) return { ignore: 'bot_sender', callbackId };
  const telegramUserId = idString(from.id);
  const message = query.message;
  const chat = isRecord(message) ? message.chat : undefined;
  const chatId = isRecord(chat) && chat.type === 'private' ? idString(chat.id) : null;
  const messageId = isRecord(message) ? idString(message.message_id) : null;
  if (!telegramUserId || !chatId || !messageId) return { ignore: 'not_private', callbackId };
  if (typeof query.data !== 'string' || !CALLBACK_DATA.test(query.data)) return { ignore: 'not_text', callbackId };
  return { press: { callbackId, telegramUserId, chatId, messageId, data: query.data, languageCode: languageCodeOf(from) } };
}

/** A `/start <code>` of a private chat with a person. */
export interface StartCommand {
  telegramUserId: string;
  chatId: string;
  code: string;
  /** `@username`, else the first name, bounded: shown to the owner only, to recognise the account. */
  label: string | null;
  languageCode: string | null;
}

/** The text of a message, stripped of control characters and cut. */
export function boundText(text: string, max = INBOUND_MAX_CHARS): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
  return [...clean].length <= max ? clean : `${[...clean].slice(0, max - 1).join('')}…`;
}

function privateSender(message: Record<string, unknown>): { telegramUserId: string; chatId: string; from: Record<string, unknown> } | null {
  const chat = message.chat;
  const from = message.from;
  if (!isRecord(chat) || chat.type !== 'private' || !isRecord(from) || from.is_bot === true) return null;
  const telegramUserId = idString(from.id);
  const chatId = idString(chat.id);
  return telegramUserId && chatId ? { telegramUserId, chatId, from } : null;
}

export function startCommandOf(update: unknown): StartCommand | null {
  if (!isRecord(update) || !isRecord(update.message) || typeof update.message.text !== 'string') return null;
  const sender = privateSender(update.message);
  const match = START_COMMAND.exec(update.message.text.trim());
  if (!sender || !match) return null;
  const { from } = sender;
  const name = typeof from.username === 'string' && from.username ? `@${from.username}` : typeof from.first_name === 'string' ? from.first_name : '';
  const label = boundText(name, 64);
  return { telegramUserId: sender.telegramUserId, chatId: sender.chatId, code: match[1], label: label === '' ? null : label, languageCode: languageCodeOf(from) };
}

/** A message of a private chat with a person: text (a command split out), voice, or other. */
export interface TelegramMessage {
  telegramUserId: string;
  chatId: string;
  messageId: string | null;
  text: string | null;
  command: { name: string; arg: string | null } | null;
  voice: Record<string, unknown> | null;
  languageCode: string | null;
  raw: Record<string, unknown>;
}

export function messageOf(update: unknown): TelegramMessage | null {
  if (!isRecord(update) || !isRecord(update.message)) return null;
  const message = update.message;
  const sender = privateSender(message);
  if (!sender) return null;
  const text = typeof message.text === 'string' ? boundText(message.text) : null;
  const command = text ? BOT_COMMAND.exec(text) : null;
  return {
    telegramUserId: sender.telegramUserId,
    chatId: sender.chatId,
    messageId: idString(message.message_id),
    text: text === '' ? null : text,
    command: command ? { name: command[1].toLowerCase(), arg: command[2]?.trim().slice(0, 200) || null } : null,
    voice: isRecord(message.voice) ? message.voice : null,
    languageCode: languageCodeOf(sender.from),
    raw: message,
  };
}

/** The wait after `failures` failed polls in a row: 5 s, 10 s, 20 s… up to 15 minutes; never 0. */
export function backoffMs(failures: number): number {
  const exponent = Math.max(0, Math.min(failures, 20) - 1);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
}

/** The state code of a failed Bot API call (no secret, no text). */
export function classifyTelegramStatus(status: number): string {
  if (status === 409) return 'WEBHOOK_SET';
  if (status === 401 || status === 404) return 'TOKEN_INVALID';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'TELEGRAM_UNAVAILABLE';
  if (status === 0) return 'NETWORK';
  return `HTTP_${status}`;
}

/** The public bot id of a token (`<botId>:<secret>`). Not secret. */
export function botIdOf(token: string): string | null {
  const match = /^(\d{1,20}):/.exec(token);
  return match ? match[1] : null;
}

/** A token shaped like the Bot API's: anything else is refused before it reaches a URL (where an error would log it). */
export function isBotToken(token: unknown): token is string {
  return typeof token === 'string' && /^\d{1,20}:[A-Za-z0-9_-]{1,200}$/.test(token);
}

/** Splits a text into `sendMessage` chunks (at a line break near the limit), 3 at most, the last one marked when cut. */
export function chunkForTelegram(text: string, max = TELEGRAM_SEND_MAX_CHARS, maxChunks = 3): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > 0 && chunks.length < maxChunks) {
    if (rest.length <= max) {
      chunks.push(rest);
      return chunks;
    }
    const breakAt = rest.lastIndexOf('\n', max);
    let end = breakAt > max / 2 ? breakAt : max;
    if (/[\uD800-\uDBFF]/.test(rest.charAt(end - 1))) end -= 1;
    chunks.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest.length > 0 && chunks.length > 0) chunks[chunks.length - 1] = `${chunks[chunks.length - 1].slice(0, max - 1)}…`;
  return chunks;
}

/** `u<userId>` = a user's own bot; `telegram` = the operator's bot. */
export const OPERATOR_BOT_REF = 'telegram';

export function userBotRef(userId: number): string {
  return `u${userId}`;
}

export function userOfBotRef(botRef: string): number | null {
  const match = /^u([1-9]\d{0,14})$/.exec(botRef);
  return match ? Number(match[1]) : null;
}

/** A bot reference of the module (path parameter of the webhook route). */
export function isBotRef(value: unknown): value is string {
  return typeof value === 'string' && (value === OPERATOR_BOT_REF || userOfBotRef(value) !== null);
}
