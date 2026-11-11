/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// The buttons of a question card on Telegram (04 §8.3, human review required). `callback_data` =
// `ix:<cardKey>:<i>:<mac>`: `cardKey` 12 base64url characters (9 random bytes, never derived from an id), `i` the action
// index 0-3, `mac` the first 8 base64url characters of HMAC-SHA256(K, "ix|" + botRef + "|" + cardKey + "|" + i). 26 bytes
// (Bot API limit: 64). The signature is checked BEFORE any database access; the card's binding is checked after.

import { createHmac, randomBytes } from 'crypto';
import { constantTimeEqual } from './codes';

export const CALLBACK_PREFIX = 'ix:';
export const CARD_KEY_LENGTH = 12;
const MAC_LENGTH = 8;
const CALLBACK_PATTERN = /^ix:([A-Za-z0-9_-]{12}):([0-3]):([A-Za-z0-9_-]{8})$/;

export interface CardCallback {
  cardKey: string;
  index: number;
  mac: string;
}

/** 9 random bytes, base64url: 72 bits, opaque. */
export function newCardKey(): string {
  return randomBytes(9).toString('base64url');
}

function macOf(key: Buffer, botRef: string, cardKey: string, index: number): string {
  return createHmac('sha256', key).update(`ix|${botRef}|${cardKey}|${index}`, 'utf8').digest('base64url').slice(0, MAC_LENGTH);
}

/** The `callback_data` of action `index` of a card sent through `botRef`. */
export function signCallback(key: Buffer, botRef: string, cardKey: string, index: number): string {
  if (!/^[A-Za-z0-9_-]{12}$/.test(cardKey) || !Number.isInteger(index) || index < 0 || index > 3) throw new Error('Invalid card button');
  return `${CALLBACK_PREFIX}${cardKey}:${index}:${macOf(key, botRef, cardKey, index)}`;
}

/** The parts of a well-formed `ix:` callback, or null. */
export function parseCallback(data: string): CardCallback | null {
  const match = CALLBACK_PATTERN.exec(data);
  if (!match) return null;
  return { cardKey: match[1], index: Number(match[2]), mac: match[3] };
}

/** The signature is the one the module computes for this bot (constant-time comparison). */
export function verifyCallback(key: Buffer, botRef: string, callback: CardCallback): boolean {
  return constantTimeEqual(callback.mac, macOf(key, botRef, callback.cardKey, callback.index));
}

/** Where a card was sent (its row's `binding`) and where a press comes from. */
export interface CardBinding {
  botRef: string;
  chatId: string;
  telegramUserId: string;
  messageId: string;
}

/**
 * A press belongs to the card only when it comes from the Telegram account the card was sent to, through the bot that
 * sent it, on the card's own message in the card's chat. A card whose message id is not known yet matches nothing.
 */
export function pressMatchesBinding(binding: Partial<CardBinding> | null | undefined, press: CardBinding): boolean {
  if (!binding || !binding.messageId) return false;
  return binding.botRef === press.botRef && binding.chatId === press.chatId && binding.messageId === press.messageId && binding.telegramUserId === press.telegramUserId;
}
