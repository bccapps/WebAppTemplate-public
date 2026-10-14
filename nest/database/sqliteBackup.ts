/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * SQLite safety net: `synchronize` rewrites a table (copy + drop) when an entity column changes, and a column removed or retyped
 * by a new release loses its data. Before the schema is applied to an EXISTING SQLite file whose app version changed since the last
 * boot, a consistent copy is made next to it: `<db>.bak-<oldVersion>-<timestamp>` (the last 3 are kept).
 *
 * The version of the last boot lives in a sidecar file `<db>.version`. Current version: `APP_VERSION` env, else the `version` of
 * the app's package.json. A failed backup is logged and does not block the boot unless `DB_BACKUP_REQUIRED=true`.
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';

export interface BackupOptions {
  /** How many backups to keep (default 3). */
  keep?: number;
  /** Throw when the backup fails (`DB_BACKUP_REQUIRED=true`). */
  required?: boolean;
  now?: Date;
}

export interface BackupResult {
  status: 'skipped' | 'backed-up' | 'failed';
  path?: string;
  reason?: string;
}

/** The running app version: `APP_VERSION`, else `<dir>/package.json`'s `version`, else `unknown`. */
export function resolveAppVersion(packageDirs: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  for (const dir of packageDirs) {
    try {
      const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
      if (typeof version === 'string' && version.trim()) return version.trim();
    } catch {
      /* no package.json here */
    }
  }
  return 'unknown';
}

const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'unknown';
const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');

type BackupDatabase = { backup(destination: string): Promise<unknown>; close(): unknown };
type BackupDriver = new (path: string, options: { fileMustExist: boolean }) => BackupDatabase;

function loadDriver(): BackupDriver | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('better-sqlite3') as BackupDriver;
  } catch {
    return null;
  }
}

/**
 * Removes the backups of `dbPath` beyond the `keep` most recent ones (with their `-wal` / `-shm` companions, which appear as soon as
 * a backup of a WAL database is opened).
 */
export function pruneBackups(dbPath: string, keep: number): string[] {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.bak-`;
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && !/-(wal|shm)$/.test(name))
    .map((name) => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  for (const file of files.slice(keep)) {
    try {
      unlinkSync(file.path);
      removed.push(file.path);
      for (const companion of [`${file.path}-wal`, `${file.path}-shm`]) if (existsSync(companion)) unlinkSync(companion);
    } catch {
      /* best effort */
    }
  }
  return removed;
}

/** Backs the SQLite file up when the app version differs from the one recorded at the last boot, then records the new version. */
export async function backupSqliteIfVersionChanged(dbPath: string, version: string, options: BackupOptions = {}): Promise<BackupResult> {
  if (dbPath === ':memory:') return { status: 'skipped', reason: 'in-memory database' };
  const sidecar = `${dbPath}.version`;
  const previous = existsSync(sidecar) ? readFileSync(sidecar, 'utf8').trim() : null;
  if (previous === version) return { status: 'skipped', reason: 'same version' };
  const fresh = !existsSync(dbPath) || statSync(dbPath).size === 0;
  if (fresh) {
    writeFileSync(sidecar, `${version}\n`);
    return { status: 'skipped', reason: 'new database' };
  }
  const destination = `${dbPath}.bak-${safe(previous ?? 'unknown')}-${stamp(options.now ?? new Date())}`;
  try {
    const Driver = loadDriver();
    if (!Driver) throw new Error('better-sqlite3 is not installed');
    const db = new Driver(dbPath, { fileMustExist: true });
    try {
      await db.backup(destination);
    } finally {
      db.close();
    }
    pruneBackups(dbPath, options.keep ?? 3);
    writeFileSync(sidecar, `${version}\n`);
    console.log(`[DB] SQLite backup before schema update (${previous ?? 'unknown'} → ${version}): ${destination}`);
    return { status: 'backed-up', path: destination };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (options.required) throw new Error(`[DB] SQLite backup failed and DB_BACKUP_REQUIRED=true: ${reason}`);
    console.error(`[DB] SQLite backup before schema update FAILED (boot continues): ${reason}`);
    return { status: 'failed', reason };
  }
}
