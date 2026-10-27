/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { FindOperator, type Repository } from 'typeorm';
import type { CronLockService } from '../../common/services/CronLockService';
import type { InstanceRoleService } from '../../common/services/InstanceRoleService';
import type { IssueReportEntity } from '../entities/IssueReportEntity';
import type { HubIssueStatus } from '../issueReportTypes';
import type { IssueHubClient } from './IssueHubClient';
import type { IssueReportNotificationService } from './IssueReportNotificationService';
import { IssueReportStatusService } from './IssueReportStatusService';

function row(id: string, hubNumber: number, overrides: Partial<IssueReportEntity> = {}): IssueReportEntity {
  return {
    id,
    userId: '7',
    hubNumber,
    title: `Report ${hubNumber}`,
    status: 'open',
    closedReason: null,
    closedAt: null,
    notifiedAt: null,
    createdAt: new Date('2026-10-26T09:00:00.000Z'),
    ...overrides,
  };
}

/** Interprets the where clauses the service uses: equality, `In([...])`, `IsNull()`. */
function matches(entity: IssueReportEntity, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = entity[key as keyof IssueReportEntity];
    if (expected instanceof FindOperator) {
      if (expected.type === 'isNull') return actual === null;
      if (expected.type === 'in') return (expected.value as unknown[]).includes(actual);
    }
    return actual === expected;
  });
}

interface Setup {
  rows?: IssueReportEntity[];
  answers?: Array<HubIssueStatus[] | null>;
  configured?: boolean;
  worker?: boolean;
}

function setup({ rows = [], answers = [[]], configured = true, worker = true }: Setup = {}) {
  const asked: number[][] = [];
  const lockRuns: string[] = [];
  let notifyCalls = 0;
  const repo = {
    find: async ({ where, take }: { where: Record<string, unknown>; take: number }) => rows.filter((r) => matches(r, where)).slice(0, take),
    existsBy: async (clauses: Record<string, unknown>[]) => rows.some((r) => clauses.some((clause) => matches(r, clause))),
    update: async (where: Record<string, unknown>, patch: Partial<IssueReportEntity>) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, patch));
      return { affected: hit.length };
    },
  } as unknown as Repository<IssueReportEntity>;
  const hub = {
    isConfigured: () => configured,
    statusOf: async (numbers: number[]) => {
      asked.push(numbers);
      return answers[Math.min(asked.length - 1, answers.length - 1)];
    },
  } as unknown as IssueHubClient;
  const notifications = {
    notifyPending: async () => {
      notifyCalls += 1;
      return 0;
    },
  } as unknown as IssueReportNotificationService;
  const cronLock = {
    runIfDue: async (key: string, _interval: number, fn: () => Promise<void>) => {
      lockRuns.push(key);
      await fn();
      return true;
    },
  } as unknown as CronLockService;
  const instanceRole = { isWorker: () => worker } as unknown as InstanceRoleService;
  const service = new IssueReportStatusService(repo, hub, notifications, cronLock, instanceRole);
  return { service, asked, lockRuns, rows, notifyCalls: () => notifyCalls };
}

describe('IssueReportStatusService', () => {
  it('does not call the hub when no report is open', async () => {
    const { service, asked, notifyCalls } = setup({ rows: [row('a', 1, { status: 'closed', notifiedAt: new Date() })] });
    expect(await service.syncOnce()).toEqual({ checked: 0, closed: 0, notified: 0 });
    expect(asked).toHaveLength(0);
    expect(notifyCalls()).toBe(1);
  });

  it('records the closures reported by the hub and leaves the open ones', async () => {
    const closedAt = new Date('2026-10-27T10:00:00.000Z');
    const { service, asked, rows } = setup({
      rows: [row('a', 1), row('b', 2), row('c', 3)],
      answers: [
        [
          { number: 1, status: 'closed', closedReason: 'fixed', closedAt },
          { number: 2, status: 'open', closedReason: null, closedAt: null },
          { number: 3, status: 'closed', closedReason: 'dropped', closedAt: null },
        ],
      ],
    });
    const summary = await service.syncOnce();
    expect(asked).toEqual([[1, 2, 3]]);
    expect(summary).toEqual({ checked: 3, closed: 2, notified: 0 });
    expect(rows.map((r) => [r.id, r.status, r.closedReason])).toEqual([
      ['a', 'closed', 'fixed'],
      ['b', 'open', null],
      ['c', 'closed', 'dropped'],
    ]);
    expect(rows[0].closedAt).toEqual(closedAt);
    expect(rows[2].closedAt).toBeInstanceOf(Date);
  });

  it('asks by batches of 100 numbers and stops at the first unreadable answer', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(`r${i}`, i + 1));
    const { service, asked } = setup({ rows, answers: [[], null] });
    await service.syncOnce();
    expect(asked.map((batch) => batch.length)).toEqual([100, 100]);
  });

  it('runs on a worker only, when configured, and only when there is work', async () => {
    const idle = setup({ rows: [row('a', 1, { status: 'closed', notifiedAt: new Date() })] });
    await idle.service.handleCron();
    expect(idle.lockRuns).toHaveLength(0);

    const api = setup({ rows: [row('a', 1)], worker: false });
    await api.service.handleCron();
    expect(api.lockRuns).toHaveLength(0);

    const off = setup({ rows: [row('a', 1)], configured: false });
    await off.service.handleCron();
    expect(off.lockRuns).toHaveLength(0);

    const pendingNotice = setup({ rows: [row('a', 1, { status: 'closed' })] });
    await pendingNotice.service.handleCron();
    expect(pendingNotice.lockRuns).toEqual(['issue-report-status']);
    expect(pendingNotice.asked).toHaveLength(0);
  });
});
