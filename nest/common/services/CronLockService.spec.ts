/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { CronLockService } from './CronLockService';

/** Query runner whose claim statement answers `claimed` rows, as the Postgres driver does for a SELECT. */
const makeService = (claimed: { job_key: string }[]): CronLockService => {
  const runner = {
    connect: async (): Promise<void> => undefined,
    startTransaction: async (): Promise<void> => undefined,
    commitTransaction: async (): Promise<void> => undefined,
    rollbackTransaction: async (): Promise<void> => undefined,
    release: async (): Promise<void> => undefined,
    query: async (sql: string): Promise<unknown> => (sql.includes('pg_try_advisory_xact_lock') ? [{ locked: true }] : sql.includes('claimed') ? claimed : []),
  };
  return new CronLockService({ createQueryRunner: () => runner } as never);
};

describe('CronLockService.runIfDue', () => {
  it('runs the callback when the claim returned the row', async () => {
    const callback = jest.fn(async (): Promise<void> => undefined);
    await expect(makeService([{ job_key: 'job' }]).runIfDue('job', 60_000, callback)).resolves.toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('skips the callback while the interval has not elapsed (claim returned nothing)', async () => {
    const callback = jest.fn(async (): Promise<void> => undefined);
    await expect(makeService([]).runIfDue('job', 60_000, callback)).resolves.toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it('accepts a tick early by the stamping delay: a daily claim threshold is 24 h minus one minute, a 15-min one 14 min 15 s', async () => {
    const thresholds: number[] = [];
    const runner = {
      connect: async (): Promise<void> => undefined,
      startTransaction: async (): Promise<void> => undefined,
      commitTransaction: async (): Promise<void> => undefined,
      rollbackTransaction: async (): Promise<void> => undefined,
      release: async (): Promise<void> => undefined,
      query: async (sql: string, params?: number[]): Promise<unknown> => {
        if (sql.includes('pg_try_advisory_xact_lock')) return [{ locked: true }];
        if (sql.includes('claimed')) thresholds.push(Number(params?.[1]));
        return [];
      },
    };
    const service = new CronLockService({ createQueryRunner: () => runner } as never);
    await service.runIfDue('daily', 24 * 3_600_000, async (): Promise<void> => undefined);
    await service.runIfDue('quarter', 15 * 60_000, async (): Promise<void> => undefined);
    expect(thresholds).toEqual([24 * 3_600_000 - 60_000, 15 * 60_000 - 45_000]);
  });
});

/** In-memory stand-in for the `cron_lease` table, answering the four statements `runExclusive` issues. */
const makeLeaseDb = () => {
  const rows = new Map<string, { holder: string; expiresAt: Date }>();
  const statements: string[] = [];
  const query = async (sql: string, params: unknown[] = []): Promise<unknown> => {
    statements.push(sql);
    const [key, holder, expiresAt, now] = params as [string, string, Date, Date];
    if (sql.includes('CREATE TABLE')) return [];
    if (sql.includes('INSERT INTO cron_lease')) {
      if (!rows.has(key)) rows.set(key, { holder, expiresAt });
      return [];
    }
    if (sql.includes('WITH claimed')) {
      const row = rows.get(key);
      if (row && (row.expiresAt < now || row.holder === holder)) {
        rows.set(key, { holder, expiresAt });
        return [{ lease_key: key }];
      }
      return [];
    }
    if (sql.includes('WITH renewed')) {
      const row = rows.get(key);
      if (row && row.holder === holder) {
        row.expiresAt = expiresAt;
        return [{ lease_key: key }];
      }
      return [];
    }
    if (sql.startsWith('DELETE FROM cron_lease')) {
      if (rows.get(key)?.holder === holder) rows.delete(key);
      return [];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { rows, statements, query };
};

describe('CronLockService.runExclusive (lease)', () => {
  const makeLeaseService = (db: ReturnType<typeof makeLeaseDb>): CronLockService =>
    new CronLockService({ options: { type: 'postgres' }, query: db.query, createQueryRunner: () => { throw new Error('no runner expected'); } } as never);

  it('takes the lease, runs the callback without a query runner, and releases it', async () => {
    const db = makeLeaseDb();
    const callback = jest.fn(async (): Promise<void> => {
      expect(db.rows.has('job')).toBe(true);
    });
    await expect(makeLeaseService(db).runExclusive('job', callback)).resolves.toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(db.rows.has('job')).toBe(false);
  });

  it('skips while another instance holds an unexpired lease', async () => {
    const db = makeLeaseDb();
    db.rows.set('job', { holder: 'other-instance', expiresAt: new Date(Date.now() + 60_000) });
    const callback = jest.fn(async (): Promise<void> => undefined);
    await expect(makeLeaseService(db).runExclusive('job', callback)).resolves.toBe(false);
    expect(callback).not.toHaveBeenCalled();
    expect(db.rows.get('job')?.holder).toBe('other-instance');
  });

  it('takes over a lease left expired by a dead instance', async () => {
    const db = makeLeaseDb();
    db.rows.set('job', { holder: 'dead-instance', expiresAt: new Date(Date.now() - 1) });
    const callback = jest.fn(async (): Promise<void> => undefined);
    await expect(makeLeaseService(db).runExclusive('job', callback)).resolves.toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('refuses a second concurrent run of the same key in the same process', async () => {
    const db = makeLeaseDb();
    const service = makeLeaseService(db);
    let release: (() => void) | null = null;
    const first = service.runExclusive('job', () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.runExclusive('job', async (): Promise<void> => undefined)).resolves.toBe(false);
    release!();
    await expect(first).resolves.toBe(true);
  });

  it('logs a failing callback, returns false and still releases the lease', async () => {
    const db = makeLeaseDb();
    await expect(makeLeaseService(db).runExclusive('job', async () => { throw new Error('boom'); })).resolves.toBe(false);
    expect(db.rows.has('job')).toBe(false);
  });

  it('renews the lease while a long job runs', async () => {
    jest.useFakeTimers();
    try {
      const db = makeLeaseDb();
      const service = makeLeaseService(db);
      let release: (() => void) | null = null;
      const run = service.runExclusive('job', () => new Promise<void>((resolve) => { release = resolve; }), { leaseTtlMs: 3_000 });
      await jest.advanceTimersByTimeAsync(2_500);
      expect(db.statements.filter((sql) => sql.includes('WITH renewed')).length).toBeGreaterThanOrEqual(2);
      release!();
      await expect(run).resolves.toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
