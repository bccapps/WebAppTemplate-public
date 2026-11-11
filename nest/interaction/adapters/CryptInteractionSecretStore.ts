/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { CryptService } from '../../common/services/CryptService';
import { InteractionSecretEntity } from '../entities/InteractionSecretEntity';
import { InteractionError } from '../errors/InteractionError';
import type { InteractionSecretStore } from '../types/ports';

/** The AAD / key namespace of one row: a ciphertext moved onto another row does not decrypt. */
export function secretNamespace(id: string): string {
  return `interaction:secret:${id}`;
}

/**
 * Default `InteractionSecretStore` (04 §13): `interaction_secret`, encrypted with `CryptService` directly (AES-256-GCM,
 * key derived from `CRYPT_DB_MASTER_KEY`, one namespace per row). Fails CLOSED: an unreadable row (another master key,
 * a tampered value) raises `SECRET_UNREADABLE`, never returns the ciphertext; another owner is `NOT_FOUND`. Unlike the
 * common column transformer, there is no plaintext fallback.
 */
@Injectable()
export class CryptInteractionSecretStore implements InteractionSecretStore {
  constructor(
    @InjectRepository(InteractionSecretEntity) private readonly secrets: Repository<InteractionSecretEntity>,
    private readonly crypt: CryptService,
  ) {}

  async put(ownerUserId: number | null, kind: string, value: string): Promise<string> {
    const id = randomUUID();
    const ciphertext = this.crypt.encryptForStorage(value, secretNamespace(id));
    await this.secrets.insert({ id, kind: kind.slice(0, 24), ownerUserId, ciphertext, rotatedAt: null, lastUsedAt: null });
    return id;
  }

  async rotate(id: string, ownerUserId: number | null, value: string): Promise<void> {
    await this.owned(id, ownerUserId);
    await this.secrets.update({ id }, { ciphertext: this.crypt.encryptForStorage(value, secretNamespace(id)), rotatedAt: new Date() });
  }

  async reveal(id: string, ownerUserId: number | null): Promise<string> {
    const row = await this.owned(id, ownerUserId);
    let value: unknown;
    try {
      value = this.crypt.decryptFromStorage<unknown>(row.ciphertext, secretNamespace(id));
    } catch {
      throw new InteractionError('SECRET_UNREADABLE');
    }
    if (typeof value !== 'string' || value === '') throw new InteractionError('SECRET_UNREADABLE');
    return value;
  }

  async remove(id: string): Promise<void> {
    await this.secrets.delete({ id });
  }

  private async owned(id: string, ownerUserId: number | null): Promise<InteractionSecretEntity> {
    const row = typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? await this.secrets.findOne({ where: { id } }) : null;
    if (!row || (row.ownerUserId ?? null) !== (ownerUserId ?? null)) throw new InteractionError('NOT_FOUND');
    return row;
  }
}
