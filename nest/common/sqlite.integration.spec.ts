/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Integration test on an in-memory SQLite database (better-sqlite3 must be installed; no Docker, no Postgres):
 * the portable entities of `common` and `voice` are synchronized, written and read back, and CronLockService
 * runs its in-process lock + `polling_lock` cooldown.
 *
 * The engine is read at import time by the entity decorators, so the environment is set before any dynamic import.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { TestingModule } from '@nestjs/testing';
import type { DataSource, Repository } from 'typeorm';

type Imports = {
  dataSource: DataSource;
  CronLockService: typeof import('./services/CronLockService').CronLockService;
  ThemeEntity: typeof import('./entities/ThemeEntity').ThemeEntity;
  CookieConsentEntity: typeof import('./entities/CookieConsentEntity').CookieConsentEntity;
  ConfigurationEntity: typeof import('./entities/ConfigurationEntity').default;
  VoiceProviderCatalogEntity: typeof import('../voice/entities/VoiceProviderCatalogEntity').VoiceProviderCatalogEntity;
  VoiceAccessEntity: typeof import('../voice/entities/VoiceAccessEntity').VoiceAccessEntity;
  eventRepo: Repository<import('./events/EventFeedEntityBase').EventFeedEntityBase>;
};

const previousEnv = { engine: process.env.DB_ENGINE, path: process.env.DB_PATH, sync: process.env.DB_SYNC };
let ctx: Imports;
let moduleRef: TestingModule;

beforeAll(async () => {
  process.env.DB_ENGINE = 'sqlite';
  process.env.DB_PATH = ':memory:';
  process.env.DB_SYNC = 'true';
  const { Test: TestingTest } = await import('@nestjs/testing');
  const { TypeOrmModule } = await import('@nestjs/typeorm');
  const { DataSource: Ds, Entity } = await import('typeorm');
  const { DatabaseModule } = await import('../database/DatabaseModule');
  const { buildMainDataSourceOptions } = await import('../database/databases');
  const { CronLockService } = await import('./services/CronLockService');
  const { ThemeEntity } = await import('./entities/ThemeEntity');
  const { CookieConsentEntity } = await import('./entities/CookieConsentEntity');
  const ConfigurationEntity = (await import('./entities/ConfigurationEntity')).default;
  const { VoiceProviderCatalogEntity } = await import('../voice/entities/VoiceProviderCatalogEntity');
  const { VoiceAccessEntity } = await import('../voice/entities/VoiceAccessEntity');
  const { EventFeedEntityBase } = await import('./events/EventFeedEntityBase');

  @Entity({ name: 'test_event_feed' })
  class TestEventFeedEntity extends EventFeedEntityBase {}

  const entities = [ConfigurationEntity, ThemeEntity, CookieConsentEntity, VoiceProviderCatalogEntity, VoiceAccessEntity, TestEventFeedEntity];
  const context = { baseDir: __dirname, migrationGlobs: [] as string[] };
  const mainDataSource = new Ds({ ...buildMainDataSourceOptions(context), entities });
  moduleRef = await TestingTest.createTestingModule({
    imports: [DatabaseModule.forRoot({ context, mainDataSource }), TypeOrmModule.forFeature(entities)],
    providers: [CronLockService],
  }).compile();
  await moduleRef.init(); // runs CronLockService.onApplicationBootstrap (creates polling_lock)
  ctx = {
    dataSource: mainDataSource, CronLockService, ThemeEntity, CookieConsentEntity, ConfigurationEntity,
    VoiceProviderCatalogEntity, VoiceAccessEntity, eventRepo: mainDataSource.getRepository(TestEventFeedEntity),
  };
});

afterAll(async () => {
  await moduleRef?.close();
  for (const [key, value] of Object.entries({ DB_ENGINE: previousEnv.engine, DB_PATH: previousEnv.path, DB_SYNC: previousEnv.sync })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('portable entities on in-memory SQLite', () => {
  it('uses the SQLite column types', () => {
    const theme = ctx.dataSource.getMetadata(ctx.ThemeEntity);
    const consent = ctx.dataSource.getMetadata(ctx.CookieConsentEntity);
    expect(theme.findColumnWithPropertyName('createdAt')?.type).toBe('datetime');
    expect(consent.findColumnWithPropertyName('categories')?.type).toBe('simple-json');
  });

  it('writes and reads back a configuration', async () => {
    const repo = ctx.dataSource.getRepository(ctx.ConfigurationEntity);
    const saved = await repo.save(repo.create({ name: 'k1', description: 'd', value: 'v1', type: 'string' }));
    const found = await repo.findOneByOrFail({ id: saved.id });
    expect(found.value).toBe('v1');
  });

  it('writes and reads back a theme with timestamps', async () => {
    const repo = ctx.dataSource.getRepository(ctx.ThemeEntity);
    const saved = await repo.save(repo.create({ name: 'Dark', code: 'dark', css: ':root{}' }));
    const found = await repo.findOneByOrFail({ id: saved.id });
    expect(found.code).toBe('dark');
    expect(found.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(found.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('writes and reads back a cookie consent with a JSON payload', async () => {
    const repo = ctx.dataSource.getRepository(ctx.CookieConsentEntity);
    const categories = { necessary: true, audienceMeasurement: false } as never;
    const saved = await repo.save(repo.create({ ip: '127.0.0.1', userAgent: 'jest', categories }));
    const found = await repo.findOneByOrFail({ id: saved.id });
    expect(found.categories).toEqual(categories);
  });

  it('writes and reads back voice entities (JSON column, relation, simple-array)', async () => {
    const catalog = ctx.dataSource.getRepository(ctx.VoiceProviderCatalogEntity);
    const provider = await catalog.save(catalog.create({ name: 'P', slug: 'p', type: 'tts', capabilities: ['tts', 'stt'], baseUrl: 'http://x' }));
    const access = ctx.dataSource.getRepository(ctx.VoiceAccessEntity);
    const saved = await access.save(access.create({ label: 'L', providerId: provider.id, providerConfig: { voice: 'a', speed: 1.5 } }));
    const found = await access.findOneByOrFail({ id: saved.id });
    expect(found.providerConfig).toEqual({ voice: 'a', speed: 1.5 });
    expect(found.updatedAt).toBeInstanceOf(Date);
  });

  it('appends and reads an event feed row (JSON payload)', async () => {
    const repo = ctx.eventRepo;
    const { appendFeedEvent, readEventFeed } = await import('./events/eventFeed');
    await appendFeedEvent(repo, 'ping', { n: 1 });
    const page = await readEventFeed(repo, 0, 10);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ type: 'ping', payload: { n: 1 } });
  });
});

describe('CronLockService on SQLite', () => {
  it('runIfDue runs once, then skips while the cooldown applies', async () => {
    const lock = moduleRef.get(ctx.CronLockService);
    const callback = jest.fn(async (): Promise<void> => undefined);
    await expect(lock.runIfDue('job-a', 60_000, callback)).resolves.toBe(true);
    await expect(lock.runIfDue('job-a', 60_000, callback)).resolves.toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
    const last = await lock.getLastRunAt('job-a');
    expect(last).toBeInstanceOf(Date);
    expect((await lock.getLastRunAts(['job-a', 'job-never'])).has('job-a')).toBe(true);
    expect((await lock.getLastRunAts(['job-never'])).size).toBe(0);
  });

  it('runIfDue runs again after clearLastRun', async () => {
    const lock = moduleRef.get(ctx.CronLockService);
    const callback = jest.fn(async (): Promise<void> => undefined);
    await lock.runIfDue('job-b', 60_000, callback);
    await lock.clearLastRun('job-b');
    await expect(lock.runIfDue('job-b', 60_000, callback)).resolves.toBe(true);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('runExclusive refuses a concurrent run of the same key and releases the key afterwards', async () => {
    const lock = moduleRef.get(ctx.CronLockService);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = lock.runExclusive('job-c', () => gate);
    await expect(lock.runExclusive('job-c', async () => undefined)).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    await expect(lock.runExclusive('job-c', async () => undefined)).resolves.toBe(true);
  });

  it('runExclusive returns false and frees the key when the callback throws', async () => {
    const lock = moduleRef.get(ctx.CronLockService);
    await expect(lock.runExclusive('job-d', async () => { throw new Error('boom'); })).resolves.toBe(false);
    await expect(lock.runExclusive('job-d', async () => undefined)).resolves.toBe(true);
  });
});
