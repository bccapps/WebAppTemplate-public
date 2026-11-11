/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * The reference DDL of Postgres (`interaction.postgres.sql`) is what TypeORM would run on an empty database for the
 * entities (`createSchemaBuilder().log()`, nothing executed). Runs only with `INTERACTION_TEST_PG_URL` (a throwaway
 * database); `INTERACTION_WRITE_DDL=1` rewrites the file. Three checks:
 * 1. the file is exactly the statements TypeORM plans for an empty schema (text);
 * 2. the file EXECUTED on an empty schema gives the same catalog (tables, columns with type / length / nullability /
 *    default, indexes with uniqueness, constraints) as `synchronize` on the entities;
 * 3. TypeORM sees no difference left between the entities and a schema built from the file (no drift either way).
 */
import { restoreEngineEnv } from '../../common/testing/postgresEngineEnv';
import { afterAll, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { INTERACTION_ENTITIES } from '../interactionEntities';

const file = join(__dirname, 'interaction.postgres.sql');
const url = process.env.INTERACTION_TEST_PG_URL;

afterAll(restoreEngineEnv);

(url ? describe : describe.skip)('interaction reference DDL — Postgres', () => {
  it('matches the entities', async () => {
    const dataSource = new DataSource({ type: 'postgres', url, schema: 'interaction_ddl_probe', entities: INTERACTION_ENTITIES, synchronize: false });
    await dataSource.initialize();
    const log = await dataSource.driver.createSchemaBuilder().log();
    await dataSource.destroy();
    const statements = log.upQueries.map((query) => `${query.query.split('"interaction_ddl_probe".').join('')};`);
    const ddl = `-- Reference DDL of the interaction module (Postgres), generated from the entities by ddl.postgres.spec.ts.\n-- Needs the uuid-ossp extension (CREATE EXTENSION IF NOT EXISTS "uuid-ossp") for the generated uuid ids.\n\n${statements.join('\n\n')}\n`;
    if (process.env.INTERACTION_WRITE_DDL === '1') writeFileSync(file, ddl);
    expect(readFileSync(file, 'utf8')).toBe(ddl);
  });
});

interface Catalog {
  tables: string[];
  columns: unknown[];
  indexes: unknown[];
  constraints: unknown[];
}

/** What a schema holds, with the schema name erased so that two schemas compare equal. */
async function catalogOf(query: (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>, schema: string): Promise<Catalog> {
  const strip = (text: unknown): string => String(text).split(`"${schema}".`).join('').split(`${schema}.`).join('');
  const tables = (await query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [schema])).map((row) => String(row.table_name));
  const columns = await query(
    `SELECT table_name, column_name, data_type, udt_name, character_maximum_length, numeric_precision, datetime_precision, is_nullable, column_default, is_identity, is_generated
       FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, column_name`,
    [schema],
  );
  const indexes = (await query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname`, [schema])).map((row) => ({ ...row, indexdef: strip(row.indexdef) }));
  const constraints = (
    await query(
      `SELECT c.conrelid::regclass::text AS tablename, c.conname, c.contype, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c WHERE c.connamespace = $1::regnamespace ORDER BY 1, c.conname`,
      [schema],
    )
  ).map((row) => ({ ...row, tablename: strip(row.tablename), def: strip(row.def) }));
  return { tables, columns, indexes, constraints };
}

(url ? describe : describe.skip)('interaction reference DDL — Postgres, executed', () => {
  const schemas: string[] = [];
  const fresh = (): string => {
    const schema = `ix_ddl_${randomBytes(5).toString('hex')}`;
    schemas.push(schema);
    return schema;
  };

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const client = new Client({ connectionString: url });
    await client.connect();
    for (const schema of schemas) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  async function createSchema(schema: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
    } finally {
      await client.end();
    }
  }

  /** The reference file run, statement by statement as written, on an empty schema. */
  async function applyReferenceDdl(schema: string): Promise<Catalog> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA public');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);
      await client.query(readFileSync(file, 'utf8'));
      return await catalogOf(async (sql, params) => (await client.query(sql, params)).rows, schema);
    } finally {
      await client.end();
    }
  }

  it('the file, executed, gives the same tables, columns, indexes and constraints as synchronize on the entities', async () => {
    const fromFile = await applyReferenceDdl(fresh());
    const synced = fresh();
    await createSchema(synced);
    const dataSource = new DataSource({ type: 'postgres', url, schema: synced, entities: INTERACTION_ENTITIES, synchronize: true });
    await dataSource.initialize();
    const fromEntities = await catalogOf((sql, params) => dataSource.query(sql, params), synced);
    const entityTables = dataSource.entityMetadatas.map((meta) => meta.tableName).sort();
    await dataSource.destroy();
    // The comparison is not vacuous: every entity has its table, and the catalog carries what it is meant to compare.
    expect(entityTables).toHaveLength(14);
    expect(fromEntities.tables).toEqual(entityTables);
    expect(fromEntities.columns.length).toBeGreaterThan(100);
    expect(new Set(fromEntities.columns.map((column) => (column as { is_nullable: string }).is_nullable))).toEqual(new Set(['YES', 'NO']));
    expect(fromEntities.indexes.some((index) => /UNIQUE INDEX "?UQ_ix_ticket_correlation/.test((index as { indexdef: string }).indexdef))).toBe(true);
    expect(fromEntities.constraints.some((constraint) => (constraint as { contype: string }).contype === 'p')).toBe(true);
    expect(fromFile.tables).toEqual(fromEntities.tables);
    expect(fromFile.columns).toEqual(fromEntities.columns);
    expect(fromFile.indexes).toEqual(fromEntities.indexes);
    expect(fromFile.constraints).toEqual(fromEntities.constraints);
  });

  it('TypeORM plans nothing against a schema built from the file (no drift between the file and the entities)', async () => {
    const schema = fresh();
    await applyReferenceDdl(schema);
    const dataSource = new DataSource({ type: 'postgres', url, schema, entities: INTERACTION_ENTITIES, synchronize: false });
    await dataSource.initialize();
    const log = await dataSource.driver.createSchemaBuilder().log();
    await dataSource.destroy();
    expect(log.upQueries.map((query) => query.query)).toEqual([]);
  });
});
