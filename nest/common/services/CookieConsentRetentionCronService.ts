/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { CronLockService } from './CronLockService';
import { InstanceRoleService } from './InstanceRoleService';
import { CookieConsentEntity } from '../entities/CookieConsentEntity';

/** CNIL consent-validity window — matches the client-side `vx_cookie_consent` cookie's own Max-Age. */
const RETENTION_MONTHS = 6;

/**
 * Same worker-guard + advisory-lock pattern as UserAnonymizationCronService: `runIfDue` (not
 * `runExclusive`) so the daily cadence survives a restart, not just prevents overlap within one tick.
 */
@Injectable()
export class CookieConsentRetentionCronService {
  private readonly logger = new Logger(CookieConsentRetentionCronService.name);

  constructor(
    @InjectRepository(CookieConsentEntity)
    private readonly repo: Repository<CookieConsentEntity>,
    private readonly cronLock: CronLockService,
    private readonly instanceRoleService: InstanceRoleService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'cookie-consent-retention-sweep' })
  async handleSweep(): Promise<void> {
    if (!this.instanceRoleService.isWorker()) return;

    await this.cronLock.runIfDue('cookie-consent-retention-sweep', 24 * 60 * 60 * 1000, async () => {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);

      const result = await this.repo.delete({ createdAt: LessThan(cutoff) });
      if (result.affected) {
        this.logger.log(`Cookie consent retention sweep: ${result.affected} row(s) deleted`);
      }
    });
  }
}
