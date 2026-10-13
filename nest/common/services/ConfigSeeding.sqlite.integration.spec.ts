/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Integration test on an in-memory SQLite database (better-sqlite3 must be installed): the two configuration
 * seeders run together on a fresh `config` table, the way they do at first start (module schemas register
 * during module init while ConfigSeederService seeds the app defaults on bootstrap). A key declared by both
 * must never raise `UNIQUE constraint failed: config.name`, and no other key may be lost because of it.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import ConfigurationEntity from '../entities/ConfigurationEntity';
import { ModuleConfigSchema } from '../types/ModuleConfigSchema';
import { ConfigSeederService } from './ConfigSeederService';
import { ModuleConfigSeederService } from './ModuleConfigSeederService';

// The SQLite driver is an optional dependency (projects that choose SQLite add it): skip these specs without it.
const hasSqliteDriver = ((): boolean => {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();
const describeWithSqlite = hasSqliteDriver ? describe : describe.skip;


jest.mock('src/config/defaultConfig', () => ({
  defaultConfigEntries: [
    { name: 'app_title', value: 'App', description: 'Title' },
    { name: 'shared_key', value: 'from-defaults', description: 'Declared twice' },
    { name: 'app_title', value: 'duplicated in the defaults list' },
  ],
}));

const SCHEMA: ModuleConfigSchema = {
  moduleId: 'demo',
  moduleName: 'Demo',
  description: '',
  icon: 'tune',
  fields: [
    { key: 'shared_key', label: 'Shared', description: 'Declared twice', type: 'string', defaultValue: 'from-schema', group: 'g' },
    { key: 'demo_flag', label: 'Flag', description: '', type: 'boolean', defaultValue: true, group: 'g' },
  ],
};

let dataSource: DataSource;
let repo: Repository<ConfigurationEntity>;
let errorSpy: ReturnType<typeof jest.spyOn>;

beforeEach(async () => {
  dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', synchronize: true, entities: [ConfigurationEntity] });
  await dataSource.initialize();
  repo = dataSource.getRepository(ConfigurationEntity);
  errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await dataSource.destroy();
});

describeWithSqlite('configuration seeding on a fresh SQLite database', () => {
  it('seeds defaults and schema fields run concurrently without a UNIQUE violation', async () => {
    const defaults = new ConfigSeederService(repo);
    const modules = new ModuleConfigSeederService(repo);

    await Promise.all([defaults.onApplicationBootstrap(), modules.seedSchema(SCHEMA)]);

    expect(errorSpy).not.toHaveBeenCalled();
    const names = (await repo.find()).map((row) => row.name).sort();
    expect(names).toEqual(['app_title', 'demo_flag', 'shared_key']);
    expect((await repo.findOneByOrFail({ name: 'app_title' })).value).toBe('App'); // first duplicate wins
  });

  it('is idempotent: a second start inserts nothing and keeps operator-edited values', async () => {
    const defaults = new ConfigSeederService(repo);
    const modules = new ModuleConfigSeederService(repo);
    await defaults.onApplicationBootstrap();
    await modules.seedSchema(SCHEMA);
    await repo.update({ name: 'demo_flag' }, { value: 'false' });

    await Promise.all([defaults.onApplicationBootstrap(), modules.seedSchema(SCHEMA), modules.seedSchema(SCHEMA)]);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(await repo.count()).toBe(3);
    expect((await repo.findOneByOrFail({ name: 'demo_flag' })).value).toBe('false');
  });

  it('seeds the same schema twice concurrently (two registrations of one module)', async () => {
    const modules = new ModuleConfigSeederService(repo);
    await expect(Promise.all([modules.seedSchema(SCHEMA), modules.seedSchema(SCHEMA)])).resolves.toBeDefined();
    expect(await repo.count()).toBe(1); // shared_key belongs to defaultConfig.ts and is skipped by the module seeder
  });
});

describeWithSqlite('seed precedence: defaultConfig.ts of the app over module schema defaults', () => {
  const run = (order: 'defaults-first' | 'modules-first' | 'concurrent') => {
    const defaults = new ConfigSeederService(repo);
    const modules = new ModuleConfigSeederService(repo);
    if (order === 'defaults-first') return defaults.onApplicationBootstrap().then(() => modules.seedSchema(SCHEMA));
    if (order === 'modules-first') return modules.seedSchema(SCHEMA).then(() => defaults.onApplicationBootstrap());
    return Promise.all([defaults.onApplicationBootstrap(), modules.seedSchema(SCHEMA)]);
  };

  it.each(['defaults-first', 'modules-first', 'concurrent'] as const)('a key declared on both sides takes the app value (%s)', async (order) => {
    await run(order);
    expect(errorSpy).not.toHaveBeenCalled();
    expect((await repo.findOneByOrFail({ name: 'shared_key' })).value).toBe('from-defaults');
    expect((await repo.findOneByOrFail({ name: 'demo_flag' })).value).toBe('true'); // module-only key still seeded
  });

  it.each(['defaults-first', 'modules-first', 'concurrent'] as const)('a value already in the database is never overwritten (%s)', async (order) => {
    await repo.insert({ name: 'shared_key', value: 'operator', description: '' });
    await run(order);
    expect((await repo.findOneByOrFail({ name: 'shared_key' })).value).toBe('operator');
  });
});

describeWithSqlite('insertConfigIfAbsent on Postgres (SQL only, no connection)', () => {
  it('generates ON CONFLICT DO NOTHING, the same idempotent insert as SQLite OR IGNORE', async () => {
    const pg = new DataSource({ type: 'postgres', entities: [ConfigurationEntity] });
    await (pg as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    const [sql] = pg
      .createQueryBuilder()
      .insert()
      .into(ConfigurationEntity)
      .values([{ name: 'a', value: '1', description: '' }])
      .orIgnore()
      .getQueryAndParameters();
    expect(sql).toMatch(/^INSERT INTO "config"/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
  });
});
