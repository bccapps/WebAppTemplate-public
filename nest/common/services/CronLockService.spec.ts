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
