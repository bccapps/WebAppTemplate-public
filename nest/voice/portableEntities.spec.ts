/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Postgres schema guard for `voice`: without `DB_ENGINE`, the portable entities must keep the exact column types
 * they had before the port (`jsonb`, `timestamptz`), so no Postgres migration is introduced. Metadata only.
 */
import { restoreEngineEnv } from '../common/testing/postgresEngineEnv';
import { afterAll, describe, expect, it } from '@jest/globals';
import { DataSource } from 'typeorm';
import { VoiceAccessEntity } from './entities/VoiceAccessEntity';
import { UserVoiceAccessEntity } from './entities/UserVoiceAccessEntity';
import { VoiceProviderCatalogEntity } from './entities/VoiceProviderCatalogEntity';

const EXPECTED: Array<[string, Function, Record<string, string>]> = [
  ['VoiceProviderCatalogEntity', VoiceProviderCatalogEntity, { createdAt: 'timestamptz' }],
  ['VoiceAccessEntity', VoiceAccessEntity, { providerConfig: 'jsonb', createdAt: 'timestamptz', updatedAt: 'timestamptz' }],
  ['UserVoiceAccessEntity', UserVoiceAccessEntity, { providerConfig: 'jsonb', createdAt: 'timestamptz', updatedAt: 'timestamptz' }],
];

describe('voice portable entities keep their Postgres column types', () => {
  afterAll(restoreEngineEnv);
  const dataSource = new DataSource({
    type: 'postgres',
    entities: [VoiceAccessEntity, UserVoiceAccessEntity, VoiceProviderCatalogEntity],
  });
  (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

  it.each(EXPECTED)('%s', (_name, entity, columns) => {
    const metadata = dataSource.getMetadata(entity);
    for (const [property, type] of Object.entries(columns)) {
      expect(metadata.findColumnWithPropertyName(property)?.type).toBe(type);
    }
  });
});
