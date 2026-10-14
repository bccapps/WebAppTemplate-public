/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { backupSqliteIfVersionChanged, pruneBackups, resolveAppVersion } from './sqliteBackup';

let driverAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('better-sqlite3');
} catch {
  driverAvailable = false;
}
const sqliteIt = driverAvailable ? it : it.skip;

describe('resolveAppVersion', () => {
  it('prefers APP_VERSION, then the package.json of the first directory that has one, else "unknown"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vx-ver-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.4.2' }));
    expect(resolveAppVersion([dir], { APP_VERSION: '9.9.9' })).toBe('9.9.9');
    expect(resolveAppVersion([join(dir, 'missing'), dir], {})).toBe('1.4.2');
    expect(resolveAppVersion([join(dir, 'missing')], {})).toBe('unknown');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('backupSqliteIfVersionChanged', () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vx-bak-'));
    db = join(dir, 'app.db');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeDb = (rows: number) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const handle = new Database(db);
    handle.pragma('journal_mode = WAL');
    handle.exec('CREATE TABLE IF NOT EXISTS t (id integer)');
    for (let i = 0; i < rows; i += 1) handle.exec(`INSERT INTO t VALUES (${i})`);
    handle.close();
  };
  const backups = () => readdirSync(dir).filter((name) => name.startsWith('app.db.bak-') && !/-(wal|shm)$/.test(name));

  it('never touches an in-memory database', async () => {
    expect(await backupSqliteIfVersionChanged(':memory:', '1.0.0')).toEqual({ status: 'skipped', reason: 'in-memory database' });
  });

  it('a new database only records its version', async () => {
    expect((await backupSqliteIfVersionChanged(db, '1.0.0')).reason).toBe('new database');
    expect(readFileSync(`${db}.version`, 'utf8').trim()).toBe('1.0.0');
    expect(backups()).toEqual([]);
  });

  sqliteIt('copies an existing file when the version changes, with a readable consistent copy, and records the new version', async () => {
    makeDb(5);
    writeFileSync(`${db}.version`, '1.0.0\n');
    const result = await backupSqliteIfVersionChanged(db, '1.1.0', { now: new Date('2026-10-14T20:30:15Z') });
    expect(result.status).toBe('backed-up');
    expect(result.path).toBe(`${db}.bak-1.0.0-20261014T203015`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const copy = new Database(result.path as string, { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c).toBe(5);
    copy.close();
    expect(readFileSync(`${db}.version`, 'utf8').trim()).toBe('1.1.0');
    expect((await backupSqliteIfVersionChanged(db, '1.1.0')).reason).toBe('same version');
    expect(backups()).toHaveLength(1);
  });

  sqliteIt('an existing file without a recorded version is backed up once as "unknown"', async () => {
    makeDb(1);
    const result = await backupSqliteIfVersionChanged(db, '2.0.0', { now: new Date('2026-01-02T03:04:05Z') });
    expect(result.path).toBe(`${db}.bak-unknown-20260102T030405`);
  });

  sqliteIt('keeps the last 3 backups', async () => {
    makeDb(1);
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(`${db}.version`, `${i}.0.0\n`);
      await backupSqliteIfVersionChanged(db, `${i + 1}.0.0`, { now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
      const when = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      for (const name of backups()) utimesSync(join(dir, name), when, when);
    }
    expect(backups()).toHaveLength(3);
  });

  it('a failed backup does not block the boot, nor record the version, unless it is required', async () => {
    mkdirSync(db); // a directory where the file should be: opening it as a database fails
    writeFileSync(join(db, 'x'), 'x');
    writeFileSync(`${db}.version`, '1.0.0\n');
    const soft = await backupSqliteIfVersionChanged(db, '1.1.0');
    expect(soft.status).toBe('failed');
    expect(readFileSync(`${db}.version`, 'utf8').trim()).toBe('1.0.0');
    expect(existsSync(`${db}.bak-1.0.0`)).toBe(false);
    await expect(backupSqliteIfVersionChanged(db, '1.1.0', { required: true })).rejects.toThrow('DB_BACKUP_REQUIRED=true');
  });

  it('pruneBackups removes only the old backups of that database', () => {
    for (const [name, age] of [['app.db.bak-a', 1], ['app.db.bak-b', 2], ['app.db.bak-c', 3], ['other.db.bak-x', 4]] as const) {
      writeFileSync(join(dir, name), 'x');
      const when = new Date(Date.now() - (10 - age) * 1000);
      utimesSync(join(dir, name), when, when);
    }
    expect(pruneBackups(db, 2).map((p) => p.split('/').pop())).toEqual(['app.db.bak-a']);
    expect(readdirSync(dir).sort()).toEqual(['app.db.bak-b', 'app.db.bak-c', 'other.db.bak-x']);
  });
});
