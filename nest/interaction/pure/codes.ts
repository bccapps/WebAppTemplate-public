/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// One-time codes (04 §9, §13): only their SHA-256 is stored, compared in constant time. Pure (but `timeOrderedId`,
// which keeps the last millisecond and a sequence to stay ordered within this process).

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** 32 random bytes, base64url (43 characters): fits Telegram's `start` parameter (`[A-Za-z0-9_-]`, 64 at most). */
export function newLinkCode(): string {
  return randomBytes(32).toString('base64url');
}

let lastIdMs = 0;
let idSequence = 0;

/**
 * A uuid (version 7 layout, RFC 9562) whose order is the order of creation in this process: 48 bits of milliseconds,
 * then a 12-bit sequence for the ids of one millisecond, then random bits. Sorting rows by it (`ORDER BY id`) gives
 * « newest first » even for rows created in the same millisecond (link codes: the oldest pending one falls).
 */
export function timeOrderedId(now: number = Date.now()): string {
  let ms = Math.max(now, lastIdMs);
  if (ms === lastIdMs) {
    idSequence += 1;
    if (idSequence > 0xfff) {
      ms += 1;
      idSequence = 0;
    }
  } else idSequence = 0;
  lastIdMs = ms;
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | (idSequence >> 8);
  bytes[7] = idSequence & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** SHA-256 (hex) of a code. */
export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * The stored dedup key of an app's notice (review F8): namespaced by its source, so one module's key can never suppress
 * another module's notice; hashed to a fixed width (`n:` + 64 hex, the column is `varchar(140)`).
 */
export function sourceDedupKey(source: string, dedupKey: string): string {
  // Length-prefixed: no (source, key) pair can spell another one.
  return `n:${createHash('sha256').update(`${source.length}:${source}:${dedupKey}`, 'utf8').digest('hex')}`;
}

/** SHA-256 (hex) of a recipient, normalised (trimmed, lower-cased): only this is stored by the send counters. */
export function hashTarget(target: string): string {
  return createHash('sha256').update(target.trim().toLowerCase(), 'utf8').digest('hex');
}

/** Two strings compared in constant time (for equal lengths; a length difference is answered at once). */
export function constantTimeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
