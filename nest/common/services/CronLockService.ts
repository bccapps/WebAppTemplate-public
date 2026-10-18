/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isSqliteDataSource, portableQuery } from '../utils/dbEngine';

/**
 * Default lifetime of a `runExclusive` lease (env `CRON_LEASE_TTL_MS`). The lease is renewed every
 * third of it while the callback runs, so a job may last longer than this; the value only bounds
 * how long a job stays blocked after the process holding it died without releasing it.
 */
const DEFAULT_LEASE_TTL_MS = 10 * 60_000;
/** Floor of a lease TTL (and of the renewal period derived from it). */
const MIN_LEASE_TTL_MS = 3_000;

/** Options of {@link CronLockService.runExclusive}. */
export interface RunExclusiveOptions {
  /** Lease lifetime for this job (ms); default `CRON_LEASE_TTL_MS` or 10 min. Renewed while the job runs. */
  leaseTtlMs?: number;
}

/**
 * A cron fires at a fixed wall-clock time but `last_run_at` is stamped when the previous run was claimed, a few
 * hundred ms later. A strict `elapsed >= interval` therefore refuses every second daily tick (24 h minus 0.2 s).
 * The claim accepts a tick that is early by up to this tolerance: 5 % of the interval, at most one minute.
 */
const CLAIM_TOLERANCE_RATIO = 0.05;
const CLAIM_TOLERANCE_MAX_MS = 60_000;

/** Epoch 0 in the SQLite `polling_lock` table: "never ran" (stored as ISO-8601 UTC text). */
const SQLITE_EPOCH = '1970-01-01T00:00:00.000Z';

/** Normalise a `last_run_at` value: a `Date` on Postgres, an ISO-8601 string on SQLite. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Distributed cron lock.
 *
 * `runExclusive` takes a LEASE row in `cron_lease` (`lease_key`, `holder`, `expires_at`) with two short
 * autocommitted statements, runs the callback WITHOUT holding any connection, renews the lease every third of
 * its TTL while the callback runs, and deletes it at the end. (It used to hold a pooled connection idle in a
 * transaction for the whole job, around `pg_try_advisory_xact_lock`: one pool slot per running job, and an open
 * transaction pinning VACUUM's xmin.) A process that dies mid-job leaves its lease until `expires_at`: the job
 * is then skipped by the other instances for at most one TTL.
 * `runIfDue` keeps a transaction-scoped advisory lock, but only around its claim (milliseconds), never around
 * the callback.
 *
 * On SQLite (desktop / single-instance deployments, see `database/README.md`) there is no other backend to
 * exclude: the lease is replaced by a non-blocking in-process lock (a set of held keys), and the
 * `polling_lock` table keeps persisting the cooldowns across restarts. SQLite must therefore never be shared
 * by several application instances.
 *
 * When multiple backends share the same database, only ONE instance
 * will execute a given cron job per cycle. Others skip silently.
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

  /** Keys currently held by this process: the whole lock on SQLite, the same-process guard on Postgres. */
  private readonly heldKeys = new Set<string>();
  /** Identifies this process as a lease holder (unique per process start). */
  private readonly holderId = `${hostname()}:${process.pid}:${randomUUID()}`.slice(0, 255);
  private leaseTableReady: Promise<void> | null = null;

  private get sqlite(): boolean {
    return isSqliteDataSource(this.dataSource);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.sqlite) {
      await this.dataSource.query(
        `CREATE TABLE IF NOT EXISTS polling_lock (
          job_key     VARCHAR(255) PRIMARY KEY,
          last_run_at DATETIME     NOT NULL DEFAULT '${SQLITE_EPOCH}'
        )`
      );
      return;
    }
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS polling_lock (
        job_key     VARCHAR(255) PRIMARY KEY,
        last_run_at TIMESTAMPTZ  NOT NULL DEFAULT TO_TIMESTAMP(0)
      )
    `);
    await this.ensureLeaseTable();
  }

  /** Created like `polling_lock` (raw DDL, whatever `DB_SCHEMA_MODE`), once per process, also lazily. */
  private ensureLeaseTable(): Promise<void> {
    if (!this.leaseTableReady) {
      this.leaseTableReady = this.dataSource
        .query(`
          CREATE TABLE IF NOT EXISTS cron_lease (
            lease_key  VARCHAR(255) PRIMARY KEY,
            holder     VARCHAR(255) NOT NULL,
            expires_at TIMESTAMPTZ  NOT NULL
          )
        `)
        .then(() => undefined)
        .catch((error: unknown) => {
          this.leaseTableReady = null;
          throw error;
        });
    }
    return this.leaseTableReady;
  }

  private defaultLeaseTtlMs(): number {
    const raw = Number(process.env.CRON_LEASE_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEASE_TTL_MS;
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
   * Try to take the `key` lease and run the callback exclusively (across instances AND within this process).
   * Returns true if the lease was acquired and the callback ran, false if skipped (or if the callback threw —
   * the error is logged, never rethrown). No database connection is held while the callback runs.
   */
  async runExclusive(key: string, callback: () => Promise<void>, options: RunExclusiveOptions = {}): Promise<boolean> {
    if (this.sqlite) return this.runExclusiveInProcess(key, callback);
    if (this.heldKeys.has(key)) return false;
    const ttlMs = Math.max(MIN_LEASE_TTL_MS, options.leaseTtlMs ?? this.defaultLeaseTtlMs());
    this.heldKeys.add(key);
    try {
      let acquired: boolean;
      try {
        acquired = await this.acquireLease(key, ttlMs);
      } catch (error) {
        this.logger.error(`CronLock.runExclusive "${key}": lease acquisition failed: ${(error as Error).message}`);
        return false;
      }
      if (!acquired) return false;
      return await this.runUnderLease(key, ttlMs, callback);
    } finally {
      this.heldKeys.delete(key);
    }
  }

  /** Runs the callback while renewing the lease, then releases it whatever happened. */
  private async runUnderLease(key: string, ttlMs: number, callback: () => Promise<void>): Promise<boolean> {
    const heartbeat = setInterval(() => {
      this.renewLease(key, ttlMs).catch((error: unknown) =>
        this.logger.warn(`CronLock lease "${key}" renewal failed: ${(error as Error).message}`));
    }, Math.max(MIN_LEASE_TTL_MS / 3, Math.floor(ttlMs / 3)));
    heartbeat.unref?.();
    try {
      await callback();
      return true;
    } catch (error) {
      this.logger.error(`Cron job "${key}" failed: ${(error as Error).message}`, (error as Error).stack);
      return false;
    } finally {
      clearInterval(heartbeat);
      await this.releaseLease(key).catch((error: unknown) =>
        this.logger.warn(`CronLock lease "${key}" release failed (expires on its own): ${(error as Error).message}`));
    }
  }

  /**
   * Insert-if-absent, then a conditional UPDATE that only succeeds when the lease is free (expired) or already
   * ours. Both statements are atomic on their own; two instances racing on an expired lease are serialised by
   * the row lock of the UPDATE, and the loser re-evaluates the WHERE against the winner's row.
   */
  private async acquireLease(key: string, ttlMs: number): Promise<boolean> {
    await this.ensureLeaseTable();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    await this.dataSource.query(
      `INSERT INTO cron_lease (lease_key, holder, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (lease_key) DO NOTHING`,
      [key, this.holderId, expiresAt],
    );
    // CTE read by a SELECT: a bare `UPDATE … RETURNING` makes TypeORM return `[rows, affectedCount]` (see claimWithAdvisoryLock).
    const rows: { lease_key: string }[] = await this.dataSource.query(
      `WITH claimed AS (
         UPDATE cron_lease SET holder = $2, expires_at = $3
          WHERE lease_key = $1 AND (expires_at < $4 OR holder = $2)
          RETURNING lease_key
       )
       SELECT lease_key FROM claimed`,
      [key, this.holderId, expiresAt, now],
    );
    return rows.length > 0;
  }

  private async renewLease(key: string, ttlMs: number): Promise<void> {
    const rows: { lease_key: string }[] = await this.dataSource.query(
      `WITH renewed AS (
         UPDATE cron_lease SET expires_at = $3 WHERE lease_key = $1 AND holder = $2 RETURNING lease_key
       )
       SELECT lease_key FROM renewed`,
      [key, this.holderId, new Date(Date.now() + ttlMs)],
    );
    if (rows.length === 0) this.logger.warn(`CronLock lease "${key}" was lost (expired and taken over) while the job was running.`);
  }

  private async releaseLease(key: string): Promise<void> {
    await this.dataSource.query('DELETE FROM cron_lease WHERE lease_key = $1 AND holder = $2', [key, this.holderId]);
  }

  /** SQLite flavour of `runExclusive`: non-blocking in-process lock, no transaction around the callback. */
  private async runExclusiveInProcess(key: string, callback: () => Promise<void>): Promise<boolean> {
    if (this.heldKeys.has(key)) return false;
    this.heldKeys.add(key);
    try {
      await callback();
      return true;
    } catch (error) {
      this.logger.error(`Cron job "${key}" failed: ${(error as Error).message}`, (error as Error).stack);
      return false;
    } finally {
      this.heldKeys.delete(key);
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
    let shouldRun: boolean;
    try {
      shouldRun = this.sqlite ? await this.claimInProcess(key, intervalMs) : await this.claimWithAdvisoryLock(key, intervalMs);
    } catch (error) {
      this.logger.error(`CronLock.runIfDue "${key}" failed: ${(error as Error).message}`);
      return false;
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

  /** Smallest elapsed time (ms) at which a run is claimed: the interval minus the stamping tolerance. */
  private claimThreshold(intervalMs: number): number {
    return intervalMs - Math.min(intervalMs * CLAIM_TOLERANCE_RATIO, CLAIM_TOLERANCE_MAX_MS);
  }

  /** Postgres claim: advisory lock + conditional UPDATE, committed before the callback runs. */
  private async claimWithAdvisoryLock(key: string, intervalMs: number): Promise<boolean> {
    const lockId = this.hashKey(`ifdue:${key}`);
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
        [key, this.claimThreshold(intervalMs)],
      );
      await runner.commitTransaction();
      return rows.length > 0;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  /**
   * SQLite claim: the in-process lock makes read-then-write safe (single instance), and the elapsed time is
   * computed in JS, which avoids Postgres-only date functions and `UPDATE … RETURNING` result-shape differences.
   */
  private async claimInProcess(key: string, intervalMs: number): Promise<boolean> {
    const lockKey = `ifdue:${key}`;
    if (this.heldKeys.has(lockKey)) return false;
    this.heldKeys.add(lockKey);
    try {
      const last = await this.getLastRunAt(key);
      if (last && Date.now() - last.getTime() < this.claimThreshold(intervalMs)) return false;
      await this.markRun(key);
      return true;
    } finally {
      this.heldKeys.delete(lockKey);
    }
  }

  /** Stamp `key` as having run now (insert or update); portable across Postgres and SQLite. */
  async markRun(key: string): Promise<void> {
    const sqlite = this.sqlite;
    const [sql, params] = portableQuery(
      sqlite,
      `INSERT INTO polling_lock (job_key, last_run_at) VALUES ($1, ${sqlite ? '$2' : 'NOW()'})
       ON CONFLICT (job_key) DO UPDATE SET last_run_at = EXCLUDED.last_run_at`,
      sqlite ? [key, new Date().toISOString()] : [key],
    );
    await this.dataSource.query(sql, params);
  }

  /** Forget the last run of `key` (its cooldown no longer applies). */
  async clearLastRun(key: string): Promise<void> {
    const [sql, params] = portableQuery(this.sqlite, 'DELETE FROM polling_lock WHERE job_key = $1', [key]);
    await this.dataSource.query(sql, params);
  }

  /** `getLastRunAt` for several keys in one query; keys that never ran are absent. */
  async getLastRunAts(keys: string[]): Promise<Map<string, Date>> {
    if (keys.length === 0) return new Map();
    const [sql, params] = this.sqlite
      ? [`SELECT job_key, last_run_at FROM polling_lock WHERE job_key IN (${keys.map(() => '?').join(', ')})`, keys]
      : ['SELECT job_key, last_run_at FROM polling_lock WHERE job_key = ANY($1)', [keys]];
    const rows: { job_key: string; last_run_at: Date | string }[] = await this.dataSource.query(sql, params);
    return new Map(rows.map((row): [string, Date] => [row.job_key, toDate(row.last_run_at)]).filter(([, at]) => at.getTime() > 0));
  }

  /** When `runIfDue` last claimed `key` (any backend), or null if it never ran. Read-only: lets callers say when a cooldown ends. */
  async getLastRunAt(key: string): Promise<Date | null> {
    const [sql, params] = portableQuery(this.sqlite, 'SELECT last_run_at FROM polling_lock WHERE job_key = $1', [key]);
    const rows: { last_run_at: Date | string }[] = await this.dataSource.query(sql, params);
    const at = rows[0] ? toDate(rows[0].last_run_at) : null;
    return at && at.getTime() > 0 ? at : null;
  }
}
