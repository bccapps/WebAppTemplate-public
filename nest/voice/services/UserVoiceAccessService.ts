/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VoiceSecretCipher } from './VoiceSecretCipher';
import { resealLegacyRow } from './voiceSecretReseal';
import { isSafeRegion, isSafeUserBaseUrl } from './voiceUserDispatch';
import { UserVoiceAccessEntity } from '../entities/UserVoiceAccessEntity';
import { UserUpsertVoiceAccessDto } from '../dto/UserUpsertVoiceAccessDto';

/** Table of this service's credentials in the encryption namespace (`user_voice_accesses:<field>`). */
const TABLE = 'user_voice_accesses' as const;

@Injectable()
export class UserVoiceAccessService {
  constructor(
    @InjectRepository(UserVoiceAccessEntity)
    private readonly accessRepo: Repository<UserVoiceAccessEntity>,
    private readonly cipher: VoiceSecretCipher,
  ) {}

  async list(userId: number) {
    const accesses = await this.accessRepo.find({
      where: { userId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });

    return {
      accesses: accesses.map((entry) => this.serialize(entry)),
    };
  }

  async create(userId: number, payload: UserUpsertVoiceAccessDto) {
    const created = this.accessRepo.create({
      userId,
      ...this.cipher.sealCredentials(this.stripUndefined(this.normalizePayload(payload)), TABLE),
    });
    const saved = await this.accessRepo.save(created);
    const full = await this.accessRepo.findOne({ where: { id: saved.id } });
    return this.serialize(full!);
  }

  async update(
    userId: number,
    id: number,
    payload: UserUpsertVoiceAccessDto,
  ) {
    const existing = await this.ensureOwnedAccess(userId, id);
    const patch = this.stripUndefined(this.normalizePayload(payload));
    const updated = this.accessRepo.merge(existing, patch);
    // Seals the new values and any legacy plaintext the patch did not touch (idempotent on ciphertext).
    Object.assign(updated, this.cipher.sealCredentials({ username: updated.username, password: updated.password }, TABLE));
    await this.accessRepo.save(updated);
    const full = await this.accessRepo.findOne({ where: { id } });
    return this.serialize(full!);
  }

  async delete(userId: number, id: number) {
    const existing = await this.ensureOwnedAccess(userId, id);
    await this.accessRepo.delete({ id: existing.id });
  }

  /**
   * The access with its credentials in PLAINTEXT, for provider calls only: never serialize or log the result. A legacy plaintext
   * row is re-encrypted on the way (compare-and-set, see `resealLegacyRow`). Throws when ciphertext cannot be decrypted.
   */
  async getAccessWithSecrets(userId: number, id: number) {
    const row = await this.accessRepo.findOne({ where: { id, userId } });
    if (!row) return null;
    if (this.cipher.hasPlaintext(row)) await resealLegacyRow(this.accessRepo, row, this.cipher, TABLE);
    return this.cipher.openCredentials(row, TABLE);
  }

  private async ensureOwnedAccess(userId: number, id: number) {
    const existing = await this.accessRepo.findOne({
      where: { id, userId },
    });
    if (!existing) {
      throw new NotFoundException('Access not found');
    }
    return existing;
  }

  serialize(entry: UserVoiceAccessEntity) {
    const provider = entry.provider;
    return {
      id: entry.id,
      label: entry.label,
      provider: provider ? {
        id: provider.id,
        name: provider.name,
        slug: provider.slug,
        type: provider.type,
        capabilities: provider.capabilities,
        baseUrl: provider.baseUrl,
        website: provider.website,
        signupUrl: provider.signupUrl,
      } : null,
      baseUrlOverride: entry.baseUrlOverride,
      username: this.cipher.openOrNull(entry.username, TABLE, 'username'),
      hasPassword: Boolean(entry.password && entry.password.length),
      providerConfig: entry.providerConfig,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  private normalizePayload(payload: UserUpsertVoiceAccessDto) {
    this.assertSafeTarget(payload);
    return {
      label: payload.label.trim(),
      providerId: payload.providerId,
      baseUrlOverride: this.normalizeNullable(payload.baseUrlOverride),
      username: this.normalizeNullable(payload.username),
      password:
        payload.password === undefined
          ? undefined
          : this.normalizeNullable(payload.password),
      providerConfig: payload.providerConfig ?? undefined,
    };
  }

  /** The server calls this URL / region with the user's key: refuse anything that is not a public https provider host. */
  private assertSafeTarget(payload: UserUpsertVoiceAccessDto): void {
    const base = payload.baseUrlOverride?.trim();
    if (base && !isSafeUserBaseUrl(base)) {
      throw new BadRequestException('baseUrlOverride must be an https URL on a public host name');
    }
    if (!isSafeRegion(payload.providerConfig?.region)) {
      throw new BadRequestException('providerConfig.region must be a plain region id');
    }
  }

  private normalizeNullable(value?: string | null) {
    if (value === undefined || value === null) {
      return value ?? null;
    }
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }

  private stripUndefined<T extends Record<string, unknown>>(value: T): T {
    const out = { ...value };
    (Object.keys(out) as (keyof T)[]).forEach((key) => {
      if (out[key] === undefined) {
        delete out[key];
      }
    });
    return out;
  }
}
