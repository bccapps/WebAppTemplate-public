/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMainDataSourceOptions } from './databases';
import { evaluateSchemaGuard, inspectSchemaState, runSchemaGuard, type SchemaState } from './schemaGuard';
import { resolveSchemaMode, type EnvGetter } from './schemaMode';
import { prepareSchema } from './schemaPreflight';

const env = (vars: Record<string, string>): EnvGetter => (key, legacy) => vars[`DB_${key}`] ?? (legacy ? vars[legacy] : undefined);
const state = (overrides: Partial<SchemaState>): SchemaState => ({ hasUserTables: false, hasMigrationsTable: false, appliedMigrations: 0, ...overrides });

let driverAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('better-sqlite3');
} catch {
  driverAvailable = false;
}
const sqliteIt = driverAvailable ? it : it.skip;

describe('evaluateSchemaGuard', () => {
  const migrationsMode = resolveSchemaMode('postgres', env({ DB_SCHEMA_MODE: 'migrations' }));

  it('refuses DB_SCHEMA_MODE=migrations on a database built outside migrations, and explains the ways out', () => {
    const verdict = evaluateSchemaGuard(state({ hasUserTables: true }), migrationsMode);
    expect(verdict.error).toContain('built by synchronize');
    expect(verdict.error).toContain('DB_SCHEMA_MODE=sync');
    expect(verdict.error).toContain('empty database');
    expect(verdict.error).toContain('baseline');
  });

  it('lets migrations mode start on an empty database or on one already managed by migrations', () => {
    expect(evaluateSchemaGuard(state({}), migrationsMode)).toEqual({ warnings: [] });
    expect(evaluateSchemaGuard(state({ hasUserTables: true, hasMigrationsTable: true, appliedMigrations: 3 }), migrationsMode)).toEqual({ warnings: [] });
  });

  it('only WARNS for legacy DB_MIGRATIONS_RUN on such a database (idempotent migrations used to work there)', () => {
    const legacy = resolveSchemaMode('postgres', env({ DB_MIGRATIONS_RUN: 'true' }), { nodeEnv: 'production' });
    const verdict = evaluateSchemaGuard(state({ hasUserTables: true }), legacy);
    expect(verdict.error).toBeUndefined();
    expect(verdict.warnings.join(' ')).toContain('idempotent');
  });

  it('warns loudly when synchronize is on over a database that lists applied migrations', () => {
    const sync = resolveSchemaMode('sqlite', env({ DB_SCHEMA_MODE: 'sync' }));
    const verdict = evaluateSchemaGuard(state({ hasUserTables: true, hasMigrationsTable: true, appliedMigrations: 2 }), sync);
    expect(verdict.error).toBeUndefined();
    expect(verdict.warnings.join(' ')).toContain('MIXED SCHEMA MANAGEMENT');
    expect(evaluateSchemaGuard(state({ hasUserTables: true }), sync).warnings).toEqual([]);
  });

  it('says nothing for the CLI or manual mode', () => {
    expect(evaluateSchemaGuard(state({ hasUserTables: true }), resolveSchemaMode('postgres', env({}), { cli: true }))).toEqual({ warnings: [] });
    expect(evaluateSchemaGuard(state({ hasUserTables: true }), resolveSchemaMode('postgres', env({ DB_SCHEMA_MODE: 'manual' })))).toEqual({ warnings: [] });
  });
});

describe('inspectSchemaState / runSchemaGuard on a real SQLite file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vx-guard-'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeDb = (file: string, statements: string[]) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(file);
    for (const sql of statements) db.exec(sql);
    db.close();
  };
  const options = (file: string) => ({ type: 'better-sqlite3', database: file }) as never;

  sqliteIt('reads the three facts of a database', async () => {
    const empty = join(dir, 'empty.db');
    expect(await inspectSchemaState(options(empty))).toEqual({ hasUserTables: false, hasMigrationsTable: false, appliedMigrations: 0 });
    const synced = join(dir, 'synced.db');
    makeDb(synced, ['CREATE TABLE items (id integer)']);
    expect(await inspectSchemaState(options(synced))).toEqual({ hasUserTables: true, hasMigrationsTable: false, appliedMigrations: 0 });
    const migrated = join(dir, 'migrated.db');
    makeDb(migrated, ['CREATE TABLE items (id integer)', 'CREATE TABLE migrations (id integer, timestamp bigint, name varchar)', "INSERT INTO migrations VALUES (1, 1, 'Init1')"]);
    expect(await inspectSchemaState(options(migrated))).toEqual({ hasUserTables: true, hasMigrationsTable: true, appliedMigrations: 1 });
  });

  sqliteIt('DB_SCHEMA_MODE=migrations fails fast on a synchronize-built file, with the explanation (not "table already exists")', async () => {
    const file = join(dir, 'built-by-sync.db');
    makeDb(file, ['CREATE TABLE items (id integer)']);
    const resolution = resolveSchemaMode('sqlite', env({ DB_SCHEMA_MODE: 'migrations' }));
    await expect(runSchemaGuard(options(file), resolution)).rejects.toThrow('built by synchronize');
  });

  sqliteIt('prepareSchema (the DatabaseModule hook) applies the guard and the backup to options built by buildMainDataSourceOptions', async () => {
    const keys = ['DB_ENGINE', 'DB_PATH', 'DB_SCHEMA_MODE', 'APP_VERSION', 'TYPEORM_SYNC', 'DB_MIGRATIONS_RUN', 'DB_SYNC', 'DB_SQLITE_MIGRATIONS'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    try {
      const file = join(dir, 'app.db');
      makeDb(file, ['CREATE TABLE items (id integer)']);
      process.env.DB_ENGINE = 'sqlite';
      process.env.DB_PATH = file;
      const ctx = { baseDir: join(dir, 'src'), migrationGlobs: [join(dir, 'src/migrations/*.{js,ts}')], certBaseDir: dir };

      process.env.DB_SCHEMA_MODE = 'migrations';
      await expect(prepareSchema(buildMainDataSourceOptions(ctx, { cli: false }), ctx)).rejects.toThrow('built by synchronize');

      // sync + a new version → the file is copied before the schema is applied
      process.env.DB_SCHEMA_MODE = 'sync';
      process.env.APP_VERSION = '2.0.0';
      await prepareSchema(buildMainDataSourceOptions(ctx, { cli: false }), ctx);
      const { readdirSync } = await import('fs');
      expect(readdirSync(dir).some((name) => name.startsWith('app.db.bak-unknown-'))).toBe(true);
      expect(readFileSync(`${file}.version`, 'utf8').trim()).toBe('2.0.0');

      // the CLI never backs up nor guards
      process.env.APP_VERSION = '3.0.0';
      await prepareSchema(buildMainDataSourceOptions(ctx, { cli: true }), ctx);
      expect(readFileSync(`${file}.version`, 'utf8').trim()).toBe('2.0.0');
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
