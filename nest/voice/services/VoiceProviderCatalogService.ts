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
import { VoiceProviderCatalogEntity } from '../entities/VoiceProviderCatalogEntity';

@Injectable()
export class VoiceProviderCatalogService {
  constructor(
    @InjectRepository(VoiceProviderCatalogEntity)
    private readonly repo: Repository<VoiceProviderCatalogEntity>,
  ) {}

  async list(): Promise<VoiceProviderCatalogEntity[]> {
    return this.repo.find({ order: { name: 'ASC' } });
  }

  async findBySlug(slug: string): Promise<VoiceProviderCatalogEntity | null> {
    return this.repo.findOne({ where: { slug } });
  }

  async findById(id: number): Promise<VoiceProviderCatalogEntity | null> {
    return this.repo.findOne({ where: { id } });
  }

  async create(data: Partial<VoiceProviderCatalogEntity>): Promise<VoiceProviderCatalogEntity> {
    const entity = this.repo.create(data);
    return this.repo.save(entity);
  }

  async update(id: number, data: Partial<VoiceProviderCatalogEntity>): Promise<VoiceProviderCatalogEntity> {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Provider catalog entry not found');
    const merged = this.repo.merge(existing, data);
    return this.repo.save(merged);
  }

  async delete(id: number): Promise<void> {
    const result = await this.repo.delete({ id });
    if (!result.affected) throw new NotFoundException('Provider catalog entry not found');
  }

  async upsertBySlug(data: Partial<VoiceProviderCatalogEntity> & { slug: string }): Promise<VoiceProviderCatalogEntity> {
    const existing = await this.repo.findOne({ where: { slug: data.slug } });
    if (existing) {
      const merged = this.repo.merge(existing, data);
      return this.repo.save(merged);
    }
    return this.repo.save(this.repo.create(data));
  }
}
