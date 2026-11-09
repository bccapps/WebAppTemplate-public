/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import { CryptService } from '../../common/services/CryptService';

/** Marks a stored value as ciphertext. A value without it is a legacy plaintext one and stays readable. */
export const VOICE_SECRET_PREFIX = 'enc:v1:';

/** Tables whose credential columns are encrypted at rest (the encryption namespace is `<table>:<field>`). */
export type VoiceSecretTable = 'voice_accesses' | 'user_voice_accesses';
/** Credential columns: `password` holds the provider key, `username` the account / access-key id. */
export type VoiceSecretField = 'username' | 'password';

/**
 * Encryption at rest of the credentials of voice accesses (admin and user ones) on top of `CryptService` (AES-256-GCM,
 * `CRYPT_DB_MASTER_KEY`). The namespace is bound to the table and the field (it is authenticated data), so a value copied from
 * another column or table does not decrypt. Text columns only: no column type change.
 *
 * Never logs or throws a value: errors carry the table and field names only.
 */
@Injectable()
export class VoiceSecretCipher {
  private readonly logger = new Logger(VoiceSecretCipher.name);

  constructor(private readonly crypt: CryptService) {}

  /** Whether a stored value is already ciphertext. */
  isSealed(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(VOICE_SECRET_PREFIX);
  }

  /** Encrypts a plaintext value (idempotent: an already sealed value is returned as is; null / empty stay as they are). */
  seal(value: string | null | undefined, table: VoiceSecretTable, field: VoiceSecretField): string | null {
    if (value === undefined || value === null) return null;
    if (value === '') return '';
    if (this.isSealed(value)) return value;
    return VOICE_SECRET_PREFIX + this.crypt.encryptForStorage(value, this.namespace(table, field));
  }

  /**
   * Plaintext of a stored value: ciphertext is decrypted, anything else is a legacy plaintext value and is returned unchanged.
   * Throws (without the value) when ciphertext does not authenticate (wrong master key or namespace): ciphertext must never
   * be used as a credential.
   */
  open(value: string | null | undefined, table: VoiceSecretTable, field: VoiceSecretField): string | null {
    if (value === undefined || value === null) return null;
    if (!this.isSealed(value)) return value;
    try {
      const plain = this.crypt.decryptFromStorage<string>(value.slice(VOICE_SECRET_PREFIX.length), this.namespace(table, field));
      return typeof plain === 'string' ? plain : null;
    } catch {
      throw new Error(`Cannot decrypt ${table}.${field}: wrong CRYPT_DB_MASTER_KEY or corrupted value`);
    }
  }

  /** Like {@link open} but returns null instead of throwing (for display paths); logs once per call without the value. */
  openOrNull(value: string | null | undefined, table: VoiceSecretTable, field: VoiceSecretField): string | null {
    try {
      return this.open(value, table, field);
    } catch (error) {
      this.logger.error((error as Error).message);
      return null;
    }
  }

  /** Copy of a patch / entity-like object with `username` and `password` sealed (absent keys stay absent). */
  sealCredentials<T extends { username?: string | null; password?: string | null }>(value: T, table: VoiceSecretTable): T {
    const out = { ...value };
    if (out.username !== undefined) out.username = this.seal(out.username, table, 'username');
    if (out.password !== undefined) out.password = this.seal(out.password, table, 'password');
    return out;
  }

  /** Copy of a stored row with `username` and `password` in plaintext, for provider calls only (never serialized). */
  openCredentials<T extends { username: string | null; password: string | null }>(row: T, table: VoiceSecretTable): T {
    return { ...row, username: this.open(row.username, table, 'username'), password: this.open(row.password, table, 'password') };
  }

  /** Whether a row still holds plaintext credentials (legacy), to be re-encrypted. */
  hasPlaintext(row: { username: string | null; password: string | null }): boolean {
    const plain = (v: string | null): boolean => typeof v === 'string' && v.length > 0 && !this.isSealed(v);
    return plain(row.username) || plain(row.password);
  }

  private namespace(table: VoiceSecretTable, field: VoiceSecretField): string {
    return `${table}:${field}`;
  }
}
