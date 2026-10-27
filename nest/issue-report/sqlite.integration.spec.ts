/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Integration test on an in-memory SQLite database (better-sqlite3 must be installed; no Docker, no Postgres): the
 * `issue_report` table is synchronized and the module's real queries run on it (per-user hourly count with a date
 * bound, `existsBy` with `IsNull`, the conditional claim of a closure notice, the closure update with `In`).
 *
 * The engine is read at import time by the entity decorators, so the environment is set before any dynamic import.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { DataSource, Repository } from 'typeorm';

const hasSqliteDriver = ((): boolean => {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();
const describeWithSqlite = hasSqliteDriver ? describe : describe.skip;

type Entity = import('./entities/IssueReportEntity').IssueReportEntity;

const previousEngine = process.env.DB_ENGINE;
let dataSource: DataSource;
let repo: Repository<Entity>;
let ops: typeof import('typeorm');

beforeAll(async () => {
  if (!hasSqliteDriver) return;
  process.env.DB_ENGINE = 'sqlite';
  ops = await import('typeorm');
  const { IssueReportEntity } = await import('./entities/IssueReportEntity');
  dataSource = new ops.DataSource({ type: 'better-sqlite3', database: ':memory:', synchronize: true, entities: [IssueReportEntity] });
  await dataSource.initialize();
  repo = dataSource.getRepository(IssueReportEntity);
});

afterAll(async () => {
  await dataSource?.destroy();
  if (previousEngine === undefined) delete process.env.DB_ENGINE;
  else process.env.DB_ENGINE = previousEngine;
});

describeWithSqlite('issue_report on SQLite', () => {
  it('stores a report with a generated uuid and default status', async () => {
    const saved = await repo.save(repo.create({ userId: '7', hubNumber: 1, title: 'First', closedReason: null, closedAt: null, notifiedAt: null }));
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    const read = await repo.findOneByOrFail({ id: saved.id });
    expect(read.status).toBe('open');
    expect(read.createdAt).toBeInstanceOf(Date);
  });

  it('counts the reports of a user in the last hour', async () => {
    await repo.save(repo.create({ userId: '7', hubNumber: 2, title: 'Second' }));
    await repo.save(repo.create({ userId: '8', hubNumber: 3, title: 'Other user' }));
    const since = new Date(Date.now() - 60 * 60 * 1000);
    expect(await repo.count({ where: { userId: '7', createdAt: ops.MoreThan(since) } })).toBe(2);
    expect(await repo.count({ where: { userId: '7', createdAt: ops.MoreThan(new Date(Date.now() + 60_000)) } })).toBe(0);
  });

  it('closes with In(), finds pending notices with IsNull(), and claims a notice only once', async () => {
    const open = await repo.find({ where: { status: 'open' } });
    const ids = open.filter((r) => r.hubNumber === 1).map((r) => r.id);
    const closedAt = new Date('2026-10-27T10:00:00.000Z');
    const closed = await repo.update({ id: ops.In(ids), status: 'open' }, { status: 'closed', closedReason: 'fixed', closedAt });
    expect(closed.affected).toBe(1);
    expect(await repo.existsBy([{ status: 'closed', notifiedAt: ops.IsNull() }])).toBe(true);

    const [pending] = await repo.find({ where: { status: 'closed', notifiedAt: ops.IsNull() } });
    expect(pending.closedAt?.toISOString()).toBe(closedAt.toISOString());
    const first = await repo.update({ id: pending.id, notifiedAt: ops.IsNull() }, { notifiedAt: new Date() });
    const second = await repo.update({ id: pending.id, notifiedAt: ops.IsNull() }, { notifiedAt: new Date() });
    expect(first.affected).toBe(1);
    expect(second.affected).toBe(0);
    expect(await repo.existsBy([{ status: 'closed', notifiedAt: ops.IsNull() }])).toBe(false);
  });
});
