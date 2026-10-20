/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Boot-time guard rails around the schema mode (see `schemaMode.ts`): a read-only look at the database BEFORE TypeORM applies
 * `synchronize` / `migrationsRun`, so the classic mix-ups fail fast with an explanation instead of a cryptic SQL error.
 *
 *  - `DB_SCHEMA_MODE=migrations` on a database that already has tables but no migrations table (built by `synchronize`):
 *    refuse to start. (Legacy `DB_MIGRATIONS_RUN` only warns: idempotent migrations used to work on such a database.)
 *  - synchronize on a database whose migrations table lists applied migrations: loud warning (mixed management).
 */

import { DataSource, DataSourceOptions } from 'typeorm';
import type { SchemaResolution } from './schemaMode';

export interface SchemaState {
  /** At least one table other than the migrations table (and SQLite internals). */
  hasUserTables: boolean;
  hasMigrationsTable: boolean;
  /** Rows of the migrations table (0 when it does not exist). */
  appliedMigrations: number;
}

export interface SchemaGuardVerdict {
  /** When set the app must not start: the message explains the ways out. */
  error?: string;
  warnings: string[];
}

/** Pure: what to say about a database in `state` given the resolved schema mode. */
export function evaluateSchemaGuard(state: SchemaState, resolution: SchemaResolution, connection = 'main'): SchemaGuardVerdict {
  const warnings: string[] = [];
  const label = connection === 'main' ? '' : ` "${connection}"`;
  const builtOutsideMigrations = state.hasUserTables && !state.hasMigrationsTable;

  if (resolution.migrationsRun && !resolution.synchronize && builtOutsideMigrations) {
    if (resolution.source === 'DB_SCHEMA_MODE') {
      return {
        warnings,
        error:
          `[DB]${label} DB_SCHEMA_MODE=migrations but this database already has tables and no migrations table: it was built by ` +
          'synchronize (or by hand), so the first migration would fail with "table already exists". Ways out: (1) keep the tables as ' +
          'they are with DB_SCHEMA_MODE=sync; (2) start from an empty database (delete the SQLite file / use a new schema) so the ' +
          'migrations build it; (3) baseline: create the migrations table and record the already-applied migrations, then restart.',
      };
    }
    warnings.push(
      `[DB]${label} migrations will run on a database that has tables but no migrations table (built by synchronize?). ` +
        'This only works if every migration is idempotent; set DB_SCHEMA_MODE explicitly to get a clear failure instead.'
    );
  }
  if (resolution.synchronize && state.appliedMigrations > 0) {
    warnings.push(
      `[DB]${label} MIXED SCHEMA MANAGEMENT: synchronize is ON but the migrations table lists ${state.appliedMigrations} applied migration(s). ` +
        'TypeORM will rewrite tables to match the entities, bypassing the migration history. Use DB_SCHEMA_MODE=migrations (or manual) ' +
        'if migrations own this schema, or DB_SCHEMA_MODE=sync on a database that never had migrations.'
    );
  }
  return { warnings };
}

/** Reads the schema state through a throw-away, schema-less connection (no entities, no sync, no migrations). */
export async function inspectSchemaState(options: DataSourceOptions): Promise<SchemaState> {
  const probe = new DataSource({ ...options, entities: [], subscribers: [], migrations: [], synchronize: false, migrationsRun: false } as DataSourceOptions);
  await probe.initialize();
  try {
    const migrationsTable = (options as { migrationsTableName?: string }).migrationsTableName ?? 'migrations';
    const rows: Array<{ name: string }> =
      options.type === 'postgres'
        ? await probe.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")
        : await probe.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    const names = new Set(rows.map((row) => row.name));
    const hasMigrationsTable = names.has(migrationsTable);
    let appliedMigrations = 0;
    if (hasMigrationsTable) {
      const counted: Array<{ c: string | number }> = await probe.query(`SELECT COUNT(*) AS c FROM "${migrationsTable}"`);
      appliedMigrations = Number(counted[0]?.c ?? 0);
    }
    return { hasUserTables: [...names].some((name) => name !== migrationsTable), hasMigrationsTable, appliedMigrations };
  } finally {
    await probe.destroy();
  }
}

/**
 * Runs the guard for one connection. Inspection failures (cannot connect, no permission) are NOT the guard's business: the real
 * `initialize()` reports them; only a verdict error is thrown.
 */
export async function runSchemaGuard(options: DataSourceOptions, resolution: SchemaResolution, connection = 'main'): Promise<void> {
  if (resolution.source === 'cli') return;
  if (options.type === 'better-sqlite3' && (options as { database?: string }).database === ':memory:') return;
  let state: SchemaState;
  try {
    state = await inspectSchemaState(options);
  } catch {
    return;
  }
  const verdict = evaluateSchemaGuard(state, resolution, connection);
  for (const warning of verdict.warnings) console.warn(warning);
  if (verdict.error) throw new Error(verdict.error);
}
