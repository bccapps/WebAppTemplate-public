/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Postgres schema guard for `interaction`: without `DB_ENGINE`, dates are `timestamptz` and JSON is `jsonb`. Metadata only. */
import { restoreEngineEnv } from '../common/testing/postgresEngineEnv';
import { afterAll, describe, expect, it } from '@jest/globals';
import { DataSource } from 'typeorm';
import { INTERACTION_ENTITIES } from './interactionEntities';
import { InteractionDeliveryEntity } from './entities/InteractionDeliveryEntity';
import { InteractionTicketEntity } from './entities/InteractionTicketEntity';

describe('interaction entities keep their Postgres column types', () => {
  afterAll(restoreEngineEnv);
  const dataSource = new DataSource({ type: 'postgres', entities: INTERACTION_ENTITIES });
  (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

  it('14 tables named interaction_*, portable types only', () => {
    const tables = INTERACTION_ENTITIES.map((entity) => dataSource.getMetadata(entity).tableName);
    expect(tables).toHaveLength(14);
    for (const table of tables) expect(table).toMatch(/^interaction_[a-z_]+$/);
    const allowed = ['uuid', 'integer', 'varchar', 'boolean', 'text', 'jsonb', 'timestamptz'];
    for (const entity of INTERACTION_ENTITIES) {
      for (const column of dataSource.getMetadata(entity).columns) expect(allowed).toContain(String(column.type));
    }
  });

  it('dates are timestamptz, the reservation index is unique', () => {
    const ticket = dataSource.getMetadata(InteractionTicketEntity);
    for (const property of ['expiresAt', 'answeredAt', 'dispatchNextAt', 'createdAt']) expect(ticket.findColumnWithPropertyName(property)?.type).toBe('timestamptz');
    expect(ticket.findColumnWithPropertyName('summary')?.type).toBe('jsonb');
    const delivery = dataSource.getMetadata(InteractionDeliveryEntity);
    const unique = delivery.indices.find((index) => index.name === 'UQ_ix_delivery_dedup');
    expect(unique?.isUnique).toBe(true);
    expect(unique?.columns.map((column) => column.databaseName)).toEqual(['user_id', 'dedup_key', 'kind']);
  });
});
