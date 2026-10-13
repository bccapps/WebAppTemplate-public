/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

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
  'DB_ENGINE', 'DATABASE_ENGINE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'DB_SSLMODE', 'DB_POOLSIZE', 'DB_PATH', 'DB_SYNC', 'TYPEORM_SYNC', 'DB_MIGRATIONS_RUN',
  'DB_CONNECTIONS', 'DB_MODULE_ROUTING', 'DB__ARCHIVE__ENGINE', 'DB__ARCHIVE__PATH',
  'DB__ARCHIVE__HOST', 'NODE_ENV',
];

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
      });
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
        extra: { ssl: { rejectUnauthorized: true }, sslmode: 'require' },
      });
      expect(o).not.toHaveProperty('migrationsRun');
    });

    it('keeps the cloud pool tuning', () => {
      process.env.DATABASE_ENGINE = 'neon';
      const o = buildMainDataSourceOptions(ctx()) as unknown as { extra: Record<string, unknown> };
      expect(o.extra).toMatchObject({ max: 10, keepAlive: true, options: '-c statement_timeout=30000' });
    });

    it('honours DB_MIGRATIONS_RUN for postgres too', () => {
      process.env.DB_MIGRATIONS_RUN = 'true';
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ migrationsRun: true });
    });
  });

  describe('sqlite', () => {
    it('resolves a relative path from certBaseDir and creates the parent folder', () => {
      process.env.DATABASE_ENGINE = 'sqlite';
      process.env.DB_PATH = 'data/app.db';
      const o = buildMainDataSourceOptions(ctx()) as unknown as Record<string, unknown>;
      expect(o.type).toBe('better-sqlite3');
      expect(o.database).toBe(join(backDir, 'data/app.db'));
      expect(existsSync(join(backDir, 'data'))).toBe(true);
      expect(o.migrations).toEqual([join(backDir, 'src/migrations/*.{js,ts}')]);
    });

    it('keeps an absolute path and prefers DB_ENGINE over DATABASE_ENGINE', () => {
      process.env.DATABASE_ENGINE = 'postgres';
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
    });

    it('sets migrationsRun only when DB_MIGRATIONS_RUN is true', () => {
      Object.assign(process.env, { DB_ENGINE: 'sqlite', DB_PATH: ':memory:' });
      expect(buildMainDataSourceOptions(ctx())).not.toHaveProperty('migrationsRun');
      process.env.DB_MIGRATIONS_RUN = 'true';
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ migrationsRun: true });
    });

    it('follows the synchronize rules (production default off, override on)', () => {
      Object.assign(process.env, { DB_ENGINE: 'sqlite', DB_PATH: ':memory:', NODE_ENV: 'production' });
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ synchronize: false });
      process.env.DB_SYNC = 'true';
      expect(buildMainDataSourceOptions(ctx())).toMatchObject({ synchronize: true });
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
      process.env.DATABASE_ENGINE = 'sqlite';
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
