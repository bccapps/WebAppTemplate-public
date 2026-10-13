/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { SystemInfoService } from './SystemInfoService';
import { ModuleConfigService } from './ModuleConfigService';
import { CronLockService } from './CronLockService';
import { InstanceRoleService } from './InstanceRoleService';
import { CryptService } from './CryptService';
import { isSqliteDataSource, portableQuery } from '../utils/dbEngine';

const DISK_ALERT_KEY = 'disk-alert-sent';
const DISK_THRESHOLD = 90;
const PROWL_KEY = 'notif_prowl_api_key';

@Injectable()
export class DiskAlertService {
  private readonly logger = new Logger(DiskAlertService.name);
  private readonly prowlEndpoint = process.env.PROWL_API_URL ?? 'https://api.prowlapp.com/publicapi';
  private readonly application = process.env.PROJECT_NAME ?? 'UnknownApp';

  constructor(
    private readonly systemInfoService: SystemInfoService,
    private readonly moduleConfigService: ModuleConfigService,
    private readonly cronLockService: CronLockService,
    private readonly instanceRoleService: InstanceRoleService,
    private readonly cryptService: CryptService,
    private readonly dataSource: DataSource,
  ) {}

  @Cron('0 * * * *')
  async checkDisk(): Promise<void> {
    if (!this.instanceRoleService.isWorker()) return;
    await this.cronLockService.runExclusive('disk-alert-check', async () => {
      await this.run();
    });
  }

  private async run(): Promise<void> {
    const enabled = this.moduleConfigService.getDecryptedValue('common_diskAlert_enabled');
    if (enabled !== true && enabled !== 'true') return;

    const info = await this.systemInfoService.getSystemInfo();
    const usagePercent = info.disk.usagePercent;

    if (usagePercent <= DISK_THRESHOLD) {
      await this.cronLockService.clearLastRun(DISK_ALERT_KEY);
      return;
    }

    const lastSent = await this.cronLockService.getLastRunAt(DISK_ALERT_KEY);

    const nowUtc = new Date();
    const todayUtc = nowUtc.toISOString().slice(0, 10);
    const currentUtcHour = nowUtc.getUTCHours();

    if (!lastSent) {
      await this.cronLockService.markRun(DISK_ALERT_KEY);
      await this.sendToAdmins(usagePercent);
      return;
    }

    const lastSentDate = lastSent.toISOString().slice(0, 10);
    if (lastSentDate === todayUtc) return;
    if (currentUtcHour !== 6) return;

    await this.cronLockService.markRun(DISK_ALERT_KEY);
    await this.sendToAdmins(usagePercent);
  }

  private async sendToAdmins(usagePercent: number): Promise<void> {
    const [sql, params] = portableQuery(
      isSqliteDataSource(this.dataSource),
      `SELECT us.user_id, us.value, us.encrypted
         FROM user_setting us
         INNER JOIN "user" u ON u.id = us.user_id
         WHERE u.admin = true
           AND us.key = $1
           AND us.value IS NOT NULL
           AND us.value != ''`,
      [PROWL_KEY],
    );
    const rows: Array<{ user_id: number; value: string | null; encrypted: boolean }> =
      await this.dataSource.query(sql, params);

    if (rows.length === 0) {
      this.logger.debug('[DiskAlert] No admin Prowl keys configured — skipping notification');
      return;
    }

    const used = Math.round(usagePercent);
    const event = `Disk Alert: ${used}% used`;
    const description = `Server disk usage has reached ${used}%. Free up space to avoid outages.`;

    for (const row of rows) {
      try {
        const apiKey = row.encrypted && row.value
          ? this.cryptService.decryptFromStorage<string>(
              row.value,
              `user:${row.user_id}:setting:${PROWL_KEY}`,
            )
          : (row.value ?? '');
        if (!apiKey) continue;
        await this.sendProwl(apiKey, event, description);
        this.logger.log(`[DiskAlert] Prowl sent to admin ${row.user_id} — disk at ${used}%`);
      } catch (err) {
        this.logger.warn(`[DiskAlert] Failed to notify admin ${row.user_id}: ${(err as Error).message}`);
      }
    }
  }

  private async sendProwl(apiKey: string, event: string, description: string): Promise<void> {
    const body = new URLSearchParams({
      apikey: apiKey,
      application: this.application,
      event,
      description,
    }).toString();
    const response = await fetch(`${this.prowlEndpoint}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.warn(`[DiskAlert] Prowl failed (${response.status}): ${text}`);
    }
  }
}
