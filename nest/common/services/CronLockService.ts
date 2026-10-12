/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * A cron fires at a fixed wall-clock time but `last_run_at` is stamped when the previous run was claimed, a few
 * hundred ms later. A strict `elapsed >= interval` therefore refuses every second daily tick (24 h minus 0.2 s).
 * The claim accepts a tick that is early by up to this tolerance: 5 % of the interval, at most one minute.
 */
const CLAIM_TOLERANCE_RATIO = 0.05;
const CLAIM_TOLERANCE_MAX_MS = 60_000;

/**
 * Distributed cron lock using Postgres advisory locks.
 *
 * When multiple backends share the same database, only ONE instance
 * will execute a given cron job per cycle. Others skip silently.
 *
 * Uses pg_try_advisory_xact_lock (transaction-scoped) so the lock
 * is automatically released even if the callback throws.
 *
 * Usage in a cron service:
 *   constructor(private readonly cronLock: CronLockService) {}
 *
 *   @Cron('0 * * * *')
 *   async handleHourly() {
 *     await this.cronLock.runExclusive('my-job-hourly', async () => {
 *       // only one instance runs this
 *     });
 *   }
 */
@Injectable()
export class CronLockService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CronLockService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS polling_lock (
        job_key     VARCHAR(255) PRIMARY KEY,
        last_run_at TIMESTAMPTZ  NOT NULL DEFAULT TO_TIMESTAMP(0)
      )
    `);
  }

  /**
   * Convert a string key into a stable 32-bit integer for pg advisory lock.
   */
  private hashKey(key: string): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return hash;
  }

  /**
   * Try to acquire an advisory lock and run the callback exclusively.
   * Returns true if the lock was acquired and the callback ran, false if skipped.
   */
  async runExclusive(key: string, callback: () => Promise<void>): Promise<boolean> {
    const lockId = this.hashKey(key);
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const [{ locked }] = await runner.query(
        'SELECT pg_try_advisory_xact_lock($1) AS locked',
        [lockId],
      );
      if (!locked) {
        await runner.commitTransaction();
        return false;
      }
      await callback();
      await runner.commitTransaction();
      return true;
    } catch (error) {
      await runner.rollbackTransaction();
      this.logger.error(`Cron job "${key}" failed: ${(error as Error).message}`, (error as Error).stack);
      return false;
    } finally {
      await runner.release();
    }
  }

  /**
   * Run callback if and only if:
   * 1. This backend wins the distributed advisory lock (non-blocking — others skip immediately).
   * 2. At least `intervalMs` ms have elapsed since the job last ran across ALL backends
   *    (persisted in the `polling_lock` table so late-starting instances respect the cooldown).
   *
   * The timestamp is committed to DB before the callback runs, so even if the callback
   * throws the cooldown still applies (avoids hammering on repeated failures).
   *
   * Returns true if the callback ran, false if skipped (lock busy or not yet due).
   */
  async runIfDue(key: string, intervalMs: number, callback: () => Promise<void>): Promise<boolean> {
    const lockId = this.hashKey(`ifdue:${key}`);
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let shouldRun = false;
    try {
      const [{ locked }] = await runner.query(
        'SELECT pg_try_advisory_xact_lock($1) AS locked',
        [lockId],
      );
      if (!locked) {
        await runner.commitTransaction();
        return false;
      }

      // Ensure row exists (epoch 0 means "never ran")
      await runner.query(
        `INSERT INTO polling_lock (job_key, last_run_at)
         VALUES ($1, TO_TIMESTAMP(0))
         ON CONFLICT (job_key) DO NOTHING`,
        [key],
      );

      // Claim the run only if the interval has elapsed. The UPDATE sits in a CTE read by a SELECT: a bare
      // `UPDATE … RETURNING` makes TypeORM return `[rows, affectedCount]`, whose length is always 2 — every
      // run would then count as claimed and the cooldown would never apply.
      const rows: { job_key: string }[] = await runner.query(
        `WITH claimed AS (
           UPDATE polling_lock
              SET last_run_at = NOW()
            WHERE job_key = $1
              AND EXTRACT(EPOCH FROM (NOW() - last_run_at)) * 1000 >= $2
            RETURNING job_key
         )
         SELECT job_key FROM claimed`,
        [key, intervalMs - Math.min(intervalMs * CLAIM_TOLERANCE_RATIO, CLAIM_TOLERANCE_MAX_MS)],
      );
      shouldRun = rows.length > 0;
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      this.logger.error(`CronLock.runIfDue "${key}" failed: ${(error as Error).message}`);
      return false;
    } finally {
      await runner.release();
    }

    if (!shouldRun) return false;

    try {
      await callback();
      return true;
    } catch (error) {
      this.logger.error(`Cron job "${key}" failed: ${(error as Error).message}`, (error as Error).stack);
      return false;
    }
  }

  /** `getLastRunAt` for several keys in one query; keys that never ran are absent. */
  async getLastRunAts(keys: string[]): Promise<Map<string, Date>> {
    const rows: { job_key: string; last_run_at: Date }[] = await this.dataSource.query('SELECT job_key, last_run_at FROM polling_lock WHERE job_key = ANY($1)', [keys]);
    return new Map(rows.filter((row) => row.last_run_at.getTime() > 0).map((row): [string, Date] => [row.job_key, new Date(row.last_run_at)]));
  }

  /** When `runIfDue` last claimed `key` (any backend), or null if it never ran. Read-only: lets callers say when a cooldown ends. */
  async getLastRunAt(key: string): Promise<Date | null> {
    const rows: { last_run_at: Date }[] = await this.dataSource.query('SELECT last_run_at FROM polling_lock WHERE job_key = $1', [key]);
    const at = rows[0]?.last_run_at;
    return at && at.getTime() > 0 ? new Date(at) : null;
  }
}
