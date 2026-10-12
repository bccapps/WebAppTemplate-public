/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VoiceAccessEntity } from '../entities/VoiceAccessEntity';
import { UpsertVoiceAccessDto } from '../dto/UpsertVoiceAccessDto';

@Injectable()
export class VoiceAccessService {
  constructor(
    @InjectRepository(VoiceAccessEntity)
    private readonly accessRepo: Repository<VoiceAccessEntity>,
  ) {}

  async listAll() {
    const accesses = await this.accessRepo.find({ order: { createdAt: 'DESC', id: 'DESC' } });
    return {
      accesses: accesses.map((entry) => this.serialize(entry)),
    };
  }

  async create(payload: UpsertVoiceAccessDto) {
    const created = this.accessRepo.create(
      this.stripUndefined(this.normalizePayload(payload)),
    );
    const entry = await this.accessRepo.save(created);
    const full = await this.accessRepo.findOne({ where: { id: entry.id } });
    return this.serialize(full!);
  }

  async update(id: number, payload: UpsertVoiceAccessDto) {
    const existing = await this.accessRepo.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Access not found');
    }

    const patch = this.stripUndefined(this.normalizePayload(payload));
    const updated = this.accessRepo.merge(existing, patch);
    await this.accessRepo.save(updated);
    const full = await this.accessRepo.findOne({ where: { id } });
    return this.serialize(full!);
  }

  async delete(id: number) {
    const result = await this.accessRepo.delete({ id });
    if (!result.affected) {
      throw new NotFoundException('Access not found');
    }
  }

  async getAccessWithSecrets(id: number) {
    return this.accessRepo.findOne({ where: { id } });
  }

  serialize(entry: VoiceAccessEntity) {
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
      username: entry.username,
      hasPassword: Boolean(entry.password && entry.password.length),
      providerConfig: entry.providerConfig,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  private normalizePayload(payload: UpsertVoiceAccessDto) {
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
