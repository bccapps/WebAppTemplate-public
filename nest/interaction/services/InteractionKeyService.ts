/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { createHmac, hkdfSync } from 'crypto';
import { STORAGE_SALT_FALLBACK } from '../../common/constants/crypt.constants';

/**
 * The HKDF `info` of each purpose (domain separation). Never of the form `web3c:db:<namespace>`, the `info` of
 * `CryptService`'s storage keys (which also mix a random per-value salt): no namespace of the secret store or of an
 * encrypted column can yield one of these keys, and one purpose's key reveals nothing of another's.
 */
export const INTERACTION_KEY_INFO = { callback: 'interaction:telegram-callback', webhook: 'interaction:telegram-webhook' } as const;

/**
 * Purpose-bound keys derived from `CRYPT_DB_MASTER_KEY` (04 §8.3, §19), never stored nor logged: the signing key of the
 * Telegram buttons and the per-bot secret of the Telegram webhook route. HKDF-SHA256(master, salt, info, 32) with the
 * master key decoded and the salt chosen EXACTLY as `CryptService` does (hex when the trimmed value is even-length hex,
 * else base64; `CRYPT_DB_DERIVATION_SALT` or `STORAGE_SALT_FALLBACK`) and a distinct `info` per purpose
 * (`INTERACTION_KEY_INFO`). 04 §19 asked for a public derivation function of `CryptService`; this lot may not modify
 * `common`, hence this copy of its decoding: `InteractionKeyService.spec.ts` decrypts a `CryptService` ciphertext with
 * the master key and salt decoded here, so the two cannot diverge unnoticed (to move into
 * `CryptService.deriveKey(purpose)` later). Rotation of the master key (a restart with another value): every key
 * changes; open Telegram cards stop verifying (generic refusal) and the webhook of each bot is set again with its new
 * secret at the first reconciliation (the fleet keeps no secret across restarts).
 */
@Injectable()
export class InteractionKeyService {
  private readonly master: Buffer;
  private readonly salt: Buffer;
  private readonly cache = new Map<string, Buffer>();

  constructor() {
    const input = process.env.CRYPT_DB_MASTER_KEY?.trim() ?? '';
    const master = /^[0-9a-fA-F]+$/.test(input) && input.length % 2 === 0 ? Buffer.from(input, 'hex') : Buffer.from(input, 'base64');
    if (master.length < 32) throw new Error('[interaction] CRYPT_DB_MASTER_KEY is missing or shorter than 32 bytes');
    this.master = master;
    this.salt = Buffer.from(process.env.CRYPT_DB_DERIVATION_SALT ?? STORAGE_SALT_FALLBACK, 'utf8');
  }

  private derive(info: string): Buffer {
    const cached = this.cache.get(info);
    if (cached) return cached;
    const key = Buffer.from(hkdfSync('sha256', this.master, this.salt, Buffer.from(info, 'utf8'), 32));
    this.cache.set(info, key);
    return key;
  }

  /** K of 04 §8.3: signs the `ix:` buttons. */
  callbackKey(): Buffer {
    return this.derive(INTERACTION_KEY_INFO.callback);
  }

  /** `X-Telegram-Bot-Api-Secret-Token` of a bot (`[A-Za-z0-9_-]`, 43 characters), bound to its reference and its id. */
  webhookSecret(botRef: string, botId: string): string {
    return createHmac('sha256', this.derive(INTERACTION_KEY_INFO.webhook)).update(`${botRef}|${botId}`, 'utf8').digest('base64url');
  }
}
