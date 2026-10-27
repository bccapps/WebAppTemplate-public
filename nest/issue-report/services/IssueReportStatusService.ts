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
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { CronLockService } from '../../common/services/CronLockService';
import { InstanceRoleService } from '../../common/services/InstanceRoleService';
import { IssueReportEntity } from '../entities/IssueReportEntity';
import { ISSUE_HUB_STATUS_BATCH, ISSUE_REPORT_SYNC_MAX, type HubIssueStatus } from '../issueReportTypes';
import { IssueHubClient } from './IssueHubClient';
import { IssueReportNotificationService } from './IssueReportNotificationService';

export const ISSUE_REPORT_STATUS_CRON = '0 */15 * * * *';
const LOCK_KEY = 'issue-report-status';
/** A little under the cron period, so a run a few seconds early is not skipped. */
const LOCK_INTERVAL_MS = 14 * 60 * 1000;

export interface IssueReportSyncSummary {
  checked: number;
  closed: number;
  notified: number;
}

/**
 * Every 15 minutes, on a worker, when the hub is configured: asks the hub for the state of the OPEN reports (nothing
 * is called when there are none), records the closures, then sends the pending closure notices.
 */
@Injectable()
export class IssueReportStatusService {
  private readonly logger = new Logger(IssueReportStatusService.name);

  constructor(
    @InjectRepository(IssueReportEntity)
    private readonly repo: Repository<IssueReportEntity>,
    private readonly hub: IssueHubClient,
    private readonly notifications: IssueReportNotificationService,
    private readonly cronLock: CronLockService,
    private readonly instanceRole: InstanceRoleService,
  ) {}

  @Cron(ISSUE_REPORT_STATUS_CRON, { name: 'issue-report-status' })
  async handleCron(): Promise<void> {
    if (!this.instanceRole.isWorker() || !this.hub.isConfigured() || !(await this.hasWork())) return;
    await this.cronLock.runIfDue(LOCK_KEY, LOCK_INTERVAL_MS, async () => {
      const summary = await this.syncOnce();
      if (summary.closed || summary.notified) {
        this.logger.log(`Issue reports: ${summary.closed} closed on the hub, ${summary.notified} reporter(s) notified`);
      }
    });
  }

  /** An open report to follow, or a closure notice still to send. No work: the run stops before taking the lock. */
  async hasWork(): Promise<boolean> {
    return this.repo.existsBy([{ status: 'open' }, { status: 'closed', notifiedAt: IsNull() }]);
  }

  /** One pass (exported for tests and manual runs). */
  async syncOnce(): Promise<IssueReportSyncSummary> {
    const open = await this.repo.find({
      where: { status: 'open' },
      select: { id: true, hubNumber: true },
      order: { createdAt: 'ASC' },
      take: ISSUE_REPORT_SYNC_MAX,
    });
    let closed = 0;
    const numbers = [...new Set(open.map((report) => report.hubNumber))];
    for (let start = 0; start < numbers.length; start += ISSUE_HUB_STATUS_BATCH) {
      const statuses = await this.hub.statusOf(numbers.slice(start, start + ISSUE_HUB_STATUS_BATCH));
      if (statuses === null) break; // hub unreachable: the next run tries again
      closed += await this.applyClosures(open, statuses);
    }
    const notified = await this.notifications.notifyPending();
    return { checked: open.length, closed, notified };
  }

  /** Marks closed the open reports whose hub issue is closed; returns how many rows changed. */
  private async applyClosures(open: IssueReportEntity[], statuses: HubIssueStatus[]): Promise<number> {
    let changed = 0;
    for (const status of statuses) {
      if (status.status !== 'closed') continue;
      const ids = open.filter((report) => report.hubNumber === status.number).map((report) => report.id);
      if (ids.length === 0) continue;
      const result = await this.repo.update(
        { id: In(ids), status: 'open' },
        { status: 'closed', closedReason: status.closedReason ?? 'manual', closedAt: status.closedAt ?? new Date() },
      );
      changed += result.affected ?? 0;
    }
    return changed;
  }
}
