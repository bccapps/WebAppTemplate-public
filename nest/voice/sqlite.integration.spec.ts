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
 * the portable entities of `voice` are synchronized, written and read back (JSON column, relation, dates).
 *
 * The engine is read at import time by the entity decorators, so the environment is set before any dynamic import.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';

type Imports = {
  dataSource: DataSource;
  VoiceProviderCatalogEntity: typeof import('./entities/VoiceProviderCatalogEntity').VoiceProviderCatalogEntity;
  VoiceAccessEntity: typeof import('./entities/VoiceAccessEntity').VoiceAccessEntity;
};

const previousEnv = { engine: process.env.DB_ENGINE };
let ctx: Imports;
let moduleRef: TestingModule;

beforeAll(async () => {
  process.env.DB_ENGINE = 'sqlite';
  const { Test: TestingTest } = await import('@nestjs/testing');
  const { TypeOrmModule } = await import('@nestjs/typeorm');
  const { DataSource: Ds } = await import('typeorm');
  const { VoiceProviderCatalogEntity } = await import('./entities/VoiceProviderCatalogEntity');
  const { VoiceAccessEntity } = await import('./entities/VoiceAccessEntity');

  const entities = [VoiceProviderCatalogEntity, VoiceAccessEntity];
  moduleRef = await TestingTest.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({ type: 'better-sqlite3', database: ':memory:', synchronize: true, entities }),
      TypeOrmModule.forFeature(entities),
    ],
  }).compile();
  await moduleRef.init();
  ctx = { dataSource: moduleRef.get(Ds), VoiceProviderCatalogEntity, VoiceAccessEntity };
});

afterAll(async () => {
  await moduleRef?.close();
  if (previousEnv.engine === undefined) delete process.env.DB_ENGINE;
  else process.env.DB_ENGINE = previousEnv.engine;
});

describe('voice entities on in-memory SQLite', () => {
  it('writes and reads back voice entities (JSON column, relation, simple-array)', async () => {
    const catalog = ctx.dataSource.getRepository(ctx.VoiceProviderCatalogEntity);
    const provider = await catalog.save(catalog.create({ name: 'P', slug: 'p', type: 'tts', capabilities: ['tts', 'stt'], baseUrl: 'http://x' }));
    const access = ctx.dataSource.getRepository(ctx.VoiceAccessEntity);
    const saved = await access.save(access.create({ label: 'L', providerId: provider.id, providerConfig: { voice: 'a', speed: 1.5 } }));
    const found = await access.findOneByOrFail({ id: saved.id });
    expect(found.providerConfig).toEqual({ voice: 'a', speed: 1.5 });
    expect(found.updatedAt).toBeInstanceOf(Date);
  });
});
