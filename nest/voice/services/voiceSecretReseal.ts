/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Logger } from '@nestjs/common';
import type { FindOptionsWhere, ObjectLiteral, Repository } from 'typeorm';
import type { VoiceSecretCipher, VoiceSecretField, VoiceSecretTable } from './VoiceSecretCipher';

const logger = new Logger('voiceSecretReseal');
const FIELDS: VoiceSecretField[] = ['username', 'password'];

interface CredentialRow {
  id: number;
  username: string | null;
  password: string | null;
}

/**
 * Opportunistic migration of a legacy plaintext row: every plaintext credential is replaced by its ciphertext with a
 * compare-and-set (`UPDATE ... WHERE id = ? AND <field> = <the plaintext just read>`), so a concurrent save of a new value is
 * never overwritten by a stale re-encryption. Failures are logged (field name only) and swallowed: the row stays readable.
 */
export async function resealLegacyRow<E extends ObjectLiteral & CredentialRow>(
  repo: Repository<E>,
  row: E,
  cipher: VoiceSecretCipher,
  table: VoiceSecretTable,
): Promise<void> {
  for (const field of FIELDS) {
    const current = row[field];
    if (typeof current !== 'string' || !current || cipher.isSealed(current)) continue;
    try {
      const sealed = cipher.seal(current, table, field);
      await repo.update({ id: row.id, [field]: current } as FindOptionsWhere<E>, { [field]: sealed } as never);
    } catch {
      logger.warn(`Could not re-encrypt ${table}.${field} of access ${row.id}`);
    }
  }
}
