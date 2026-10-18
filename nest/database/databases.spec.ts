/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildExtraDataSourceOptions,
  buildMainDataSourceOptions,
  DbContext,
} from './databases';
import { isSqlite, isSqliteDataSource, jsonColumnType, portableQuery, timestampColumnType } from './dbEngine';

const ENV_KEYS = [
  'DB_ENGINE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'DB_SSLMODE', 'DB_POOLSIZE', 'DB_PATH', 'DB_SYNC', 'TYPEORM_SYNC', 'DB_MIGRATIONS_RUN',
  'DB_CONNECTIONS', 'DB_MODULE_ROUTING', 'DB__ARCHIVE__ENGINE', 'DB__ARCHIVE__PATH',
  'DB__ARCHIVE__HOST', 'NODE_ENV', 'APP_DATA_DIR', 'DB_SQLITE_MIGRATIONS', 'DB_BUSY_TIMEOUT_MS',
  'DB_STATEMENT_TIMEOUT_MS', 'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', 'TYPEORM_CLI',
];

const SESSION_OPTIONS = '-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000';

describe('database options', () => {
  let saved: Record<string, string | undefined>;
  let backDir: string;
  const ctx = (): DbContext => ({
    baseDir: join(backDir, 'src'),
    migrationGlobs: [join(backDir, 'src/migrations/*.{js,ts}')],
    certBaseDir: backDir,
  });

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    backDir = mkdtempSync(join(tmpdir(), 'vx-db-'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  describe('postgres (unchanged)', () => {
    it('produces the legacy options by default', () => {
      expect(buildMainDataSourceOptions(ctx())).toEqual({
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: '',
        database: 'postgres',
        entities: [
          join(backDir, 'src/modules_shared/**/entities/*.{js,ts}'),
          join(backDir, 'src/modules/**/entities/*.{js,ts}'),
        ],
        migrations: [join(backDir, 'src/migrations/*.{js,ts}')],
        synchronize: true,
        logging: ['error'],
        extra: { options: SESSION_OPTIONS },
      });
    });

    it('applies statement/idle-in-transaction timeouts from the env, 0 disabling each, never for the CLI', () => {
      process.env.DB_STATEMENT_TIMEOUT_MS = '120000';
      process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = '0';
      const o = buildMainDataSourceOptions(ctx()) as unknown as { extra: Record<string, unknown> };
      expect(o.extra.options).toBe('-c statement_timeout=120000');
      process.env.DB_STATEMENT_TIMEOUT_MS = '0';
      expect(buildMainDataSourceOptions(ctx())).not.toHaveProperty('extra');
      delete process.env.DB_STATEMENT_TIMEOUT_MS;
      delete process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS;
      expect(buildMainDataSourceOptions(ctx(), { cli: true })).not.toHaveProperty('extra');
    });

    it('applies host, pool and SSL settings, without migrationsRun', () => {
      Object.assign(process.env, {
        DB_HOST: 'db', DB_PORT: '5433', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'n',
        DB_POOLSIZE: '4', DB_SSLMODE: 'require',
      });
      const o = buildMainDataSourceOptions(ctx()) as unknown as Record<string, unknown>;
      expect(o).toMatchObject({
        type: 'postgres', host: 'db', port: 5433, username: 'u', password: 'p',
        database: 'n', poolSize: 4,
        ssl: { rejectUnauthorized: true },
        extra: { ssl: { rejectUnauthorized: true }, sslmode: 'require', options: SESSION_OPTIONS },
      });
      expect(o).not.toHaveProperty('migrationsRun');
    });

    it('keeps the cloud pool tuning', () => {
      process.env.DB_ENGINE = 'neon';
      const o = buildMainDataSourceOptions(ctx()) as unknown as { extra: Record<string, unknown> };
      expect(o.extra).toMatchObject({ max: 10, keepAlive: true, options: SESSION_OPTIONS });
    });

    it('applies the session timeouts to supabase too', () => {
      process.env.DB_ENGINE = 'supabase';
      const o = buildMainDataSourceOptions(ctx()) as unknown as { extra: Record<string, unknown> };
      expect(o.extra).toMatchObject({ options: SESSION_OPTIONS });
    });

    it('honours DB_MIGRATIONS_RUN for postgres too', () => {
      process.env.DB_MIGRATIONS_RUN = 'true';
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ migrationsRun: true });
    });
  });

  describe('sqlite', () => {
    it('resolves a relative path from certBaseDir and creates the parent folder', () => {
      process.env.DB_ENGINE = 'sqlite';
      process.env.DB_PATH = 'data/app.db';
      const o = buildMainDataSourceOptions(ctx()) as unknown as Record<string, unknown>;
      expect(o.type).toBe('better-sqlite3');
      expect(o.database).toBe(join(backDir, 'data/app.db'));
      expect(existsSync(join(backDir, 'data'))).toBe(true);
      // No SQLite migrations of its own: the Postgres-SQL migrations are never loaded, the schema comes from `synchronize`.
      expect(o.migrations).toEqual([]);
    });

    it('keeps the migrations of an app that ships SQLite migrations (DB_MIGRATIONS_RUN or DB_SQLITE_MIGRATIONS)', () => {
      Object.assign(process.env, { DB_ENGINE: 'sqlite', DB_PATH: ':memory:', DB_MIGRATIONS_RUN: 'true' });
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ migrations: [join(backDir, 'src/migrations/*.{js,ts}')] });
      delete process.env.DB_MIGRATIONS_RUN;
      process.env.DB_SQLITE_MIGRATIONS = 'true';
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ migrations: [join(backDir, 'src/migrations/*.{js,ts}')] });
    });

    it('resolves a relative path from APP_DATA_DIR when set, not from certBaseDir', () => {
      const dataDir = join(backDir, 'userdata');
      process.env.DB_ENGINE = 'sqlite';
      process.env.DB_PATH = 'data/app.db';
      process.env.APP_DATA_DIR = dataDir;
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ database: join(dataDir, 'data/app.db') });
      expect(existsSync(join(dataDir, 'data'))).toBe(true);
    });

    it('keeps an absolute path and reads the engine case-insensitively', () => {
      process.env.DB_ENGINE = 'SQLite';
      const abs = join(backDir, 'abs', 'x.db');
      process.env.DB_PATH = abs;
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ database: abs });
    });

    it('computes no Postgres, SSL or pool options', () => {
      Object.assign(process.env, { DB_ENGINE: 'sqlite', DB_PATH: ':memory:', DB_HOST: 'h', DB_SSLMODE: 'require', DB_POOLSIZE: '3' });
      const o = buildMainDataSourceOptions(ctx()) as unknown as Record<string, unknown>;
      for (const k of ['host', 'port', 'username', 'password', 'ssl', 'extra', 'poolSize']) {
        expect(o).not.toHaveProperty(k);
      }
      expect(o.database).toBe(':memory:');
    });

    it('enables WAL and foreign keys through prepareDatabase', () => {
      Object.assign(process.env, { DB_ENGINE: 'sqlite', DB_PATH: 'a.db' });
      const o = buildMainDataSourceOptions(ctx()) as unknown as {
        prepareDatabase: (db: { pragma: (s: string) => void }) => void;
      };
      const pragma = jest.fn();
      o.prepareDatabase({ pragma });
      expect(pragma).toHaveBeenCalledWith('journal_mode = WAL');
      expect(pragma).toHaveBeenCalledWith('foreign_keys = ON');
      expect(pragma).toHaveBeenCalledWith('busy_timeout = 5000');
      process.env.DB_BUSY_TIMEOUT_MS = '1500';
      const custom = jest.fn();
      (buildMainDataSourceOptions(ctx()) as unknown as { prepareDatabase: (db: { pragma: (s: string) => void }) => void }).prepareDatabase({ pragma: custom });
      expect(custom).toHaveBeenCalledWith('busy_timeout = 1500');
    });

    it('sets migrationsRun only when DB_MIGRATIONS_RUN is true', () => {
      Object.assign(process.env, { DB_ENGINE: 'sqlite', DB_PATH: ':memory:' });
      expect(buildMainDataSourceOptions(ctx())).not.toHaveProperty('migrationsRun');
      process.env.DB_MIGRATIONS_RUN = 'true';
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ migrationsRun: true });
    });

    it('app with SQLite migrations: synchronize follows the Postgres rules (production default off, DB_SCHEMA_MODE=sync turns it on)', () => {
      Object.assign(process.env, { DB_ENGINE: 'sqlite', DB_PATH: ':memory:', NODE_ENV: 'production', DB_MIGRATIONS_RUN: 'true' });
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ synchronize: false });
      process.env.DB_SCHEMA_MODE = 'sync';
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ synchronize: true });
    });

    it('app without SQLite migrations: synchronize is ON by default even in production, DB_SCHEMA_MODE=manual turns it off', () => {
      Object.assign(process.env, { DB_ENGINE: 'sqlite', DB_PATH: ':memory:', NODE_ENV: 'production' });
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ synchronize: true });
      process.env.DB_SCHEMA_MODE = 'manual';
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ synchronize: false });
    });

    it('refuses the removed TYPEORM_SYNC / DB_SYNC flags', () => {
      Object.assign(process.env, { DB_ENGINE: 'sqlite', DB_PATH: ':memory:', TYPEORM_SYNC: 'true' });
      expect(() => buildMainDataSourceOptions(ctx())).toThrow(/no longer supported: set DB_SCHEMA_MODE/);
    });

    it('requires DB_PATH', () => {
      process.env.DB_ENGINE = 'sqlite';
      expect(() => buildMainDataSourceOptions(ctx())).toThrow('DB_PATH');
    });
  });

  describe('named connections', () => {
    it('builds a sqlite named connection next to a postgres main', () => {
      Object.assign(process.env, {
        DB_CONNECTIONS: 'archive', DB__ARCHIVE__ENGINE: 'sqlite', DB__ARCHIVE__PATH: 'archive.db',
      });
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ type: 'postgres' });
      const extra = buildExtraDataSourceOptions(ctx());
      expect(extra).toHaveLength(1);
      expect(extra[0].name).toBe('archive');
      expect(extra[0].options).toMatchObject({
        name: 'archive', type: 'better-sqlite3', database: join(backDir, 'archive.db'), migrations: [],
      });
    });

    it('requires DB__<NAME>__PATH', () => {
      Object.assign(process.env, { DB_CONNECTIONS: 'archive', DB__ARCHIVE__ENGINE: 'sqlite' });
      expect(() => buildExtraDataSourceOptions(ctx())).toThrow('DB__ARCHIVE__PATH');
    });
  });

  describe('portable column types', () => {
    it('returns Postgres types by default', () => {
      expect(isSqlite()).toBe(false);
      expect(jsonColumnType()).toBe('jsonb');
      expect(timestampColumnType()).toBe('timestamptz');
    });

    it('returns SQLite types for a sqlite connection', () => {
      process.env.DB_ENGINE = 'sqlite';
      process.env.DB__ARCHIVE__ENGINE = 'postgres';
      expect(isSqlite()).toBe(true);
      expect(jsonColumnType()).toBe('simple-json');
      expect(timestampColumnType()).toBe('datetime');
      expect(isSqlite('archive')).toBe(false);
      expect(jsonColumnType('archive')).toBe('jsonb');
    });
  });

  describe('raw query portability', () => {
    it('detects a SQLite data source from its driver type', () => {
      expect(isSqliteDataSource({ options: { type: 'better-sqlite3' } })).toBe(true);
      expect(isSqliteDataSource({ options: { type: 'postgres' } })).toBe(false);
      expect(isSqliteDataSource({})).toBe(false);
    });

    it('leaves a Postgres query untouched', () => {
      expect(portableQuery(false, 'SELECT $1, $2', ['a', 'b'])).toEqual(['SELECT $1, $2', ['a', 'b']]);
    });

    it('rewrites numbered placeholders to positional ones, duplicating reused values', () => {
      expect(portableQuery(true, 'SELECT * FROM t WHERE a = $2 AND b = $1 AND c = $2', ['x', 'y'])).toEqual([
        'SELECT * FROM t WHERE a = ? AND b = ? AND c = ?',
        ['y', 'x', 'y'],
      ]);
    });
  });
});
