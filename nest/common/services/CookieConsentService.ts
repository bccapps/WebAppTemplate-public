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
import { Repository } from 'typeorm';
import { CookieConsentCategories, CookieConsentEntity } from '../entities/CookieConsentEntity';

@Injectable()
export class CookieConsentService {
  constructor(
    @InjectRepository(CookieConsentEntity)
    private readonly repo: Repository<CookieConsentEntity>,
  ) {}

  async log(params: { ip: string | null; userAgent: string | null; categories: CookieConsentCategories }): Promise<void> {
    const entity = this.repo.create({
      userId: null,
      ip: params.ip?.substring(0, 128) ?? null,
      userAgent: params.userAgent?.substring(0, 256) ?? null,
      categories: params.categories,
    });
    await this.repo.save(entity);
  }
}
