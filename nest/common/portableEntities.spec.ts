/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Postgres schema guard: without `DB_ENGINE`, the portable entities must keep the exact column types they
 * had before the port (`jsonb`, `timestamptz`), so no Postgres migration is introduced. Metadata only: no connection.
 */
import { describe, expect, it } from '@jest/globals';
import { DataSource } from 'typeorm';
import ConfigurationEntity from './entities/ConfigurationEntity';
import { CookieConsentEntity } from './entities/CookieConsentEntity';
import { ThemeEntity } from './entities/ThemeEntity';
import { VoiceAccessEntity } from '../voice/entities/VoiceAccessEntity';
import { UserVoiceAccessEntity } from '../voice/entities/UserVoiceAccessEntity';
import { VoiceProviderCatalogEntity } from '../voice/entities/VoiceProviderCatalogEntity';
import { EventFeedEntityBase } from './events/EventFeedEntityBase';
import { Entity } from 'typeorm';

@Entity({ name: 'guard_event_feed' })
class GuardEventFeedEntity extends EventFeedEntityBase {}

const EXPECTED: Array<[string, Function, Record<string, string>]> = [
  ['EventFeedEntityBase', GuardEventFeedEntity, { payload: 'jsonb', createdAt: 'timestamptz' }],
  ['CookieConsentEntity', CookieConsentEntity, { categories: 'jsonb', createdAt: 'timestamptz' }],
  ['ThemeEntity', ThemeEntity, { createdAt: 'timestamptz', updatedAt: 'timestamptz' }],
  ['VoiceProviderCatalogEntity', VoiceProviderCatalogEntity, { createdAt: 'timestamptz' }],
  ['VoiceAccessEntity', VoiceAccessEntity, { providerConfig: 'jsonb', createdAt: 'timestamptz', updatedAt: 'timestamptz' }],
  ['UserVoiceAccessEntity', UserVoiceAccessEntity, { providerConfig: 'jsonb', createdAt: 'timestamptz', updatedAt: 'timestamptz' }],
];

describe('portable entities keep their Postgres column types', () => {
  const dataSource = new DataSource({
    type: 'postgres',
    entities: [ConfigurationEntity, GuardEventFeedEntity, CookieConsentEntity, ThemeEntity, VoiceAccessEntity, UserVoiceAccessEntity, VoiceProviderCatalogEntity],
  });
  (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

  it.each(EXPECTED)('%s', (_name, entity, columns) => {
    const metadata = dataSource.getMetadata(entity);
    for (const [property, type] of Object.entries(columns)) {
      expect(metadata.findColumnWithPropertyName(property)?.type).toBe(type);
    }
  });
});
