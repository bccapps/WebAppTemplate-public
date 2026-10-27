/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AuthPort } from '../../common/auth/AuthPort';
import { AppException } from '../../common/exceptions/AppException';
import { IssueReportEntity } from '../entities/IssueReportEntity';
import type { IssueHubClient, IssueHubCreatePayload, IssueHubCreateResult } from './IssueHubClient';
import { IssueReportService } from './IssueReportService';

const usersPort = { mode: 'users' } as AuthPort;

function setup(options: { configured?: boolean; recent?: number; result?: IssueHubCreateResult; port?: AuthPort | null; saveFails?: boolean } = {}) {
  const sent: IssueHubCreatePayload[] = [];
  const saved: Partial<IssueReportEntity>[] = [];
  const countArgs: unknown[] = [];
  const hub = {
    isConfigured: () => options.configured ?? true,
    createIssue: async (payload: IssueHubCreatePayload) => {
      sent.push(payload);
      return options.result ?? { ok: true, number: 12 };
    },
  } as unknown as IssueHubClient;
  const rows: IssueReportEntity[] = [];
  const findArgs: unknown[] = [];
  const repo = {
    count: async (args: unknown) => {
      countArgs.push(args);
      return options.recent ?? 0;
    },
    create: (value: Partial<IssueReportEntity>) => value,
    save: async (value: Partial<IssueReportEntity>) => {
      if (options.saveFails) throw new Error('db down');
      saved.push(value);
      return value;
    },
    find: async (args: unknown) => {
      findArgs.push(args);
      return rows;
    },
  } as unknown as Repository<IssueReportEntity>;
  const service = new IssueReportService(repo, hub, options.port === undefined ? usersPort : options.port);
  return { service, sent, saved, countArgs, findArgs, rows };
}

async function statusOf(promise: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppException ? error.getStatus() : -1;
  }
}

const body = { title: 'Save fails', description: 'Clicking save does nothing', pageUrl: '/settings?token=abc' };

afterEach(() => {
  delete process.env.APP_VERSION;
  jest.restoreAllMocks();
});

describe('IssueReportService.isEnabled', () => {
  it('needs the hub configuration and, when an auth port exists, user accounts', () => {
    expect(setup().service.isEnabled()).toBe(true);
    expect(setup({ configured: false }).service.isEnabled()).toBe(false);
    expect(setup({ port: { mode: 'anonymous' } as AuthPort }).service.isEnabled()).toBe(false);
    expect(setup({ port: null }).service.isEnabled()).toBe(true);
  });
});

describe('IssueReportService.create', () => {
  it('relays with the principal as reporterRef (never a body value), the user agent, and keeps a row', async () => {
    const { service, sent, saved } = setup();
    const answer = await service.create(7, { ...body, reporterRef: 'someone-else', userId: 1 }, 'Mozilla/5.0');
    expect(answer).toEqual({ number: 12 });
    expect(sent).toEqual([
      { title: 'Save fails', body: 'Clicking save does nothing', reporterRef: '7', pageUrl: '/settings', userAgent: 'Mozilla/5.0' },
    ]);
    expect(saved).toEqual([
      { userId: '7', hubNumber: 12, title: 'Save fails', status: 'open', closedReason: null, closedAt: null, notifiedAt: null },
    ]);
  });

  it("prefers the server's APP_VERSION over the client's", async () => {
    process.env.APP_VERSION = '3.1.0';
    const { service, sent } = setup();
    await service.create(7, { ...body, appVersion: '0.0.1' }, undefined);
    expect(sent[0].appVersion).toBe('3.1.0');
    delete process.env.APP_VERSION;
    const other = setup();
    await other.service.create(7, { ...body, appVersion: '0.0.1' }, undefined);
    expect(other.sent[0].appVersion).toBe('0.0.1');
  });

  it('answers 503 when the module is off, without validating nor calling the hub', async () => {
    const { service, sent } = setup({ configured: false });
    expect(await statusOf(service.create(7, body, undefined))).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('answers 400 on an invalid field, without calling the hub', async () => {
    const { service, sent } = setup();
    expect(await statusOf(service.create(7, { ...body, title: 'x' }, undefined))).toBe(400);
    expect(await statusOf(service.create(7, { ...body, description: 3 }, undefined))).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('answers 429 once the user sent 10 reports in the last hour, counted per user', async () => {
    const { service, sent, countArgs } = setup({ recent: 10 });
    expect(await statusOf(service.create(7, body, undefined))).toBe(429);
    expect(sent).toHaveLength(0);
    expect((countArgs[0] as { where: { userId: string } }).where.userId).toBe('7');
  });

  it.each([
    ['rejected', 400],
    ['rate_limited', 429],
    ['unauthorized', 502],
    ['unavailable', 502],
  ] as const)('maps a hub failure %s to HTTP %i and keeps no row', async (reason, status) => {
    const { service, saved } = setup({ result: { ok: false, reason } });
    expect(await statusOf(service.create(7, body, undefined))).toBe(status);
    expect(saved).toHaveLength(0);
  });

  it('still answers the number when the local row cannot be written (the issue exists on the hub)', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service } = setup({ saveFails: true });
    expect(await service.create(7, body, undefined)).toEqual({ number: 12 });
  });
});

describe('IssueReportService.mine', () => {
  it("maps the user's rows without userId nor notifiedAt", async () => {
    const { service, rows, findArgs } = setup();
    rows.push({
      id: 'r1',
      userId: '7',
      hubNumber: 4,
      title: 'Broken',
      status: 'closed',
      closedReason: 'fixed',
      closedAt: new Date('2026-10-27T09:00:00.000Z'),
      notifiedAt: new Date('2026-10-27T09:15:00.000Z'),
      createdAt: new Date('2026-10-26T08:00:00.000Z'),
    });
    expect(await service.mine(7)).toEqual([
      {
        id: 'r1',
        number: 4,
        title: 'Broken',
        status: 'closed',
        closedReason: 'fixed',
        closedAt: '2026-10-27T09:00:00.000Z',
        createdAt: '2026-10-26T08:00:00.000Z',
      },
    ]);
    expect(findArgs[0]).toEqual({ where: { userId: '7' }, order: { createdAt: 'DESC' }, take: 50 });
  });
});
