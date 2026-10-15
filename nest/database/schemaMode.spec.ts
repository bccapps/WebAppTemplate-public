/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildExtraDataSourceOptions, buildMainDataSourceOptions } from './databases';
import { detectTypeormCli, resolveSchemaMode, SCHEMA_MODES, type EnvGetter } from './schemaMode';

const env = (vars: Record<string, string>): EnvGetter => (key, legacy) => vars[`DB_${key}`] ?? (legacy ? vars[legacy] : undefined);

describe('resolveSchemaMode', () => {
  it('maps each DB_SCHEMA_MODE value to its options, on both engines', () => {
    for (const engine of ['postgres', 'sqlite'] as const) {
      expect(resolveSchemaMode(engine, env({ DB_SCHEMA_MODE: 'sync' }))).toMatchObject({ mode: 'sync', synchronize: true, migrationsRun: false, loadMigrations: false, source: 'DB_SCHEMA_MODE' });
      expect(resolveSchemaMode(engine, env({ DB_SCHEMA_MODE: 'migrations' }))).toMatchObject({ mode: 'migrations', synchronize: false, migrationsRun: true, loadMigrations: true });
      expect(resolveSchemaMode(engine, env({ DB_SCHEMA_MODE: 'manual' }))).toMatchObject({ mode: 'manual', synchronize: false, migrationsRun: false, loadMigrations: true });
    }
  });

  it('never combines synchronize and migrationsRun from DB_SCHEMA_MODE, whatever the legacy flags say', () => {
    for (const mode of SCHEMA_MODES) {
      const r = resolveSchemaMode('postgres', env({ DB_SCHEMA_MODE: mode, DB_MIGRATIONS_RUN: 'true' }));
      expect(r.synchronize && r.migrationsRun).toBe(false);
      expect(r.mode).toBe(mode);
    }
  });

  it('is case and space insensitive, and an empty value falls through to the remaining legacy flags', () => {
    expect(resolveSchemaMode('postgres', env({ DB_SCHEMA_MODE: ' Migrations ' })).mode).toBe('migrations');
    expect(resolveSchemaMode('postgres', env({ DB_SCHEMA_MODE: '', DB_MIGRATIONS_RUN: 'true' })).source).toBe('legacy');
  });

  it('refuses an unknown value and names the accepted ones', () => {
    expect(() => resolveSchemaMode('postgres', env({ DB_SCHEMA_MODE: 'auto' }))).toThrow('DB_SCHEMA_MODE must be one of: sync, migrations, manual (got "auto")');
    expect(() => resolveSchemaMode('sqlite', env({ DB_SCHEMA_MODE: 'yes' }), { prefix: 'DB__ARCHIVE__' })).toThrow('DB__ARCHIVE__SCHEMA_MODE must be one of');
  });

  it('the TypeORM CLI always loads the migrations and never synchronizes nor auto-runs, whatever the env', () => {
    const noisy = env({ DB_SCHEMA_MODE: 'sync', DB_MIGRATIONS_RUN: 'true' });
    for (const engine of ['postgres', 'sqlite'] as const) {
      expect(resolveSchemaMode(engine, noisy, { cli: true })).toMatchObject({ mode: 'manual', synchronize: false, migrationsRun: false, loadMigrations: true, source: 'cli' });
    }
  });

  it('DB_MIGRATIONS_RUN without DB_SCHEMA_MODE next to the default synchronize is reported as mixed (kept for existing apps)', () => {
    expect(resolveSchemaMode('postgres', env({ DB_MIGRATIONS_RUN: 'true' }), { nodeEnv: 'development' })).toMatchObject({ mode: 'mixed', synchronize: true, migrationsRun: true });
    expect(resolveSchemaMode('postgres', env({ DB_MIGRATIONS_RUN: 'true' }), { nodeEnv: 'production' })).toMatchObject({ mode: 'migrations', synchronize: false, migrationsRun: true });
  });

  it('refuses the removed DB_SYNC / TYPEORM_SYNC flags (any value, any path) and names DB_SCHEMA_MODE', () => {
    for (const vars of [{ TYPEORM_SYNC: 'true' }, { TYPEORM_SYNC: 'false' }, { DB_SYNC: 'true' }, { DB_SCHEMA_MODE: 'sync', TYPEORM_SYNC: 'true' }]) {
      expect(() => resolveSchemaMode('postgres', env(vars))).toThrow(/no longer supported: set DB_SCHEMA_MODE instead/);
      expect(() => resolveSchemaMode('sqlite', env(vars), { cli: true })).toThrow(/DB_SCHEMA_MODE/);
    }
    expect(() => resolveSchemaMode('sqlite', env({}), { prefix: 'DB__ARCHIVE__' })).not.toThrow();
    const named: EnvGetter = (key) => (key === 'SYNC' ? 'true' : undefined);
    expect(() => resolveSchemaMode('postgres', named, { prefix: 'DB__ARCHIVE__' })).toThrow(/DB__ARCHIVE__SYNC is no longer supported: set DB__ARCHIVE__SCHEMA_MODE/);
    expect(() => resolveSchemaMode('postgres', env({ TYPEORM_SYNC: '  ' }))).not.toThrow();
  });

  it('warns about synchronize in production on Postgres, but allows it', () => {
    const viaMode = resolveSchemaMode('postgres', env({ DB_SCHEMA_MODE: 'sync' }), { nodeEnv: 'production' });
    expect(viaMode.synchronize).toBe(true);
    expect(viaMode.warnings.join(' ')).toContain('can DROP data');
    expect(resolveSchemaMode('sqlite', env({ DB_SCHEMA_MODE: 'sync' }), { nodeEnv: 'production' }).warnings).toEqual([]);
    expect(resolveSchemaMode('postgres', env({ DB_SCHEMA_MODE: 'sync' }), { nodeEnv: 'development' }).warnings).toEqual([]);
  });

  it('keeps the historical warning when production leaves synchronize off by default', () => {
    expect(resolveSchemaMode('postgres', env({}), { nodeEnv: 'production' }).warnings[0]).toContain('synchronize=false (production default)');
  });
});

describe('detectTypeormCli', () => {
  it('recognises the typeorm entry points and the TYPEORM_CLI marker', () => {
    expect(detectTypeormCli(['node', '/app/node_modules/typeorm/cli.js', 'migration:run'], {})).toBe(true);
    expect(detectTypeormCli(['node', '/app/node_modules/.bin/typeorm', 'migration:run'], {})).toBe(true);
    expect(detectTypeormCli(['node', '/x/typeorm-ts-node-commonjs', 'migration:run'], {})).toBe(true);
    expect(detectTypeormCli(['node', '/app/dist/main.js'], {})).toBe(false);
    expect(detectTypeormCli(['node', '/app/dist/main.js'], { TYPEORM_CLI: '1' })).toBe(true);
    expect(detectTypeormCli(['node', '/app/dist/typeorm-sync-helper.js'], {})).toBe(false);
  });
});

describe('DataSource options carry the resolution', () => {
  let saved: Record<string, string | undefined>;
  let dir: string;
  const KEYS = ['DB_ENGINE', 'DB_PATH', 'DB_SYNC', 'TYPEORM_SYNC', 'DB_MIGRATIONS_RUN', 'DB_SQLITE_MIGRATIONS', 'DB_SCHEMA_MODE', 'NODE_ENV', 'TYPEORM_CLI', 'DB_CONNECTIONS', 'DB_MODULE_ROUTING', 'DB__ARCHIVE__ENGINE', 'DB__ARCHIVE__PATH', 'DB__ARCHIVE__SCHEMA_MODE'];
  const ctx = () => ({ baseDir: join(dir, 'src'), migrationGlobs: [join(dir, 'src/migrations/*.{js,ts}')], certBaseDir: dir });

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), 'vx-mode-'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  it.each([['postgres'], ['sqlite']])('%s: DB_SCHEMA_MODE drives synchronize / migrationsRun / migrations', (engine) => {
    process.env.DB_ENGINE = engine;
    if (engine === 'sqlite') process.env.DB_PATH = ':memory:';
    process.env.NODE_ENV = 'production';
    process.env.DB_SCHEMA_MODE = 'migrations';
    expect(buildMainDataSourceOptions(ctx())).toMatchObject({ synchronize: false, migrationsRun: true, migrations: [join(dir, 'src/migrations/*.{js,ts}')] });
    process.env.DB_SCHEMA_MODE = 'sync';
    const sync = buildMainDataSourceOptions(ctx()) as { synchronize: boolean; migrationsRun?: boolean; migrations: string[] };
    expect(sync.synchronize).toBe(true);
    expect(sync.migrationsRun).toBeUndefined();
    expect(sync.migrations).toEqual([]);
    process.env.DB_SCHEMA_MODE = 'manual';
    expect(buildMainDataSourceOptions(ctx())).toMatchObject({ synchronize: false, migrations: [join(dir, 'src/migrations/*.{js,ts}')] });
  });

  it.each([['postgres'], ['sqlite']])('%s: the CLI entry ignores DB_MIGRATIONS_RUN and DB_SCHEMA_MODE', (engine) => {
    process.env.DB_ENGINE = engine;
    if (engine === 'sqlite') process.env.DB_PATH = ':memory:';
    process.env.DB_MIGRATIONS_RUN = 'true';
    process.env.DB_SCHEMA_MODE = 'sync';
    const options = buildMainDataSourceOptions(ctx(), { cli: true }) as { synchronize: boolean; migrationsRun?: boolean; migrations: string[] };
    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBeUndefined();
    expect(options.migrations).toEqual([join(dir, 'src/migrations/*.{js,ts}')]);
    process.env.TYPEORM_CLI = '1';
    expect((buildMainDataSourceOptions(ctx()) as { synchronize: boolean }).synchronize).toBe(false);
  });

  it('a named connection reads its own DB__<NAME>__SCHEMA_MODE', () => {
    process.env.DB_ENGINE = 'postgres';
    process.env.DB_CONNECTIONS = 'archive';
    process.env.DB_MODULE_ROUTING = 'x=archive';
    process.env.DB__ARCHIVE__ENGINE = 'sqlite';
    process.env.DB__ARCHIVE__PATH = ':memory:';
    process.env.DB__ARCHIVE__SCHEMA_MODE = 'sync';
    const extra = buildExtraDataSourceOptions(ctx());
    expect(extra[0]?.options).toMatchObject({ synchronize: true });
    process.env.DB__ARCHIVE__SCHEMA_MODE = 'bogus';
    expect(() => buildExtraDataSourceOptions(ctx())).toThrow('DB__ARCHIVE__SCHEMA_MODE must be one of');
  });
});
