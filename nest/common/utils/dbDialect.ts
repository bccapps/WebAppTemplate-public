/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { MAIN_CONNECTION, isSqlite, isSqliteDataSource } from './dbEngine';

/**
 * SQL fragments that differ between Postgres and SQLite, chosen by `DATABASE_ENGINE` (or by the live driver of a DataSource).
 * Use them in `createQueryBuilder()` strings and raw queries instead of writing Postgres-only SQL.
 *
 * For a plain text match prefer TypeORM's own portable `ILike()` find operator (`where: { name: ILike('%x%') }`: `ILIKE` on
 * Postgres, `UPPER() LIKE UPPER()` on SQLite). The helpers below cover query-builder strings.
 *
 * Column and path arguments are interpolated into SQL: pass identifiers you wrote (`event.at`), never user input.
 * Bind values with parameters as usual.
 */
export interface Dialect {
  /** `true` when the dialect is SQLite. */
  readonly sqlite: boolean;
  /** Case-insensitive match of `column` against the bound parameter `param` (`:q`). */
  ilike(column: string, param: string): string;
  /** `YYYY-MM` bucket of a timestamp column. */
  monthBucket(column: string): string;
  /** `YYYY-MM-DD` bucket of a timestamp column. */
  dayBucket(column: string): string;
  /** The current timestamp. */
  now(): string;
  /** Seconds since the epoch of a timestamp column. */
  epochSeconds(column: string): string;
  /** The column as text. */
  castText(column: string): string;
  /** Text value at `path` (`'a.b'`, keys `[A-Za-z0-9_]`) of a JSON column. SQLite returns the native JSON type for numbers/booleans. */
  jsonExtract(column: string, path: string): string;
  /**
   * The JSON ARRAY column contains every element of the JSON array held by the bound parameter (`JSON.stringify(['a'])`).
   * Arrays of scalars (strings, numbers, booleans); objects are compared as text on SQLite.
   */
  jsonArrayContains(column: string, param: string): string;
  /** ` FOR UPDATE` on Postgres, empty on SQLite (a write transaction is already exclusive). */
  forUpdate(): string;
  /** Applies a pessimistic write lock on Postgres; a no-op on SQLite (no row locks). */
  lockForWrite<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>): SelectQueryBuilder<T>;
}

const JSON_PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

function assertJsonPath(path: string): void {
  if (!JSON_PATH.test(path)) throw new Error(`Invalid JSON path "${path}" (keys of [A-Za-z0-9_] separated by dots)`);
}

const postgres: Dialect = {
  sqlite: false,
  ilike: (column, param) => `${column} ILIKE ${param}`,
  monthBucket: (column) => `to_char(${column}, 'YYYY-MM')`,
  dayBucket: (column) => `to_char(${column}, 'YYYY-MM-DD')`,
  now: () => 'now()',
  epochSeconds: (column) => `EXTRACT(EPOCH FROM ${column})`,
  castText: (column) => `CAST(${column} AS TEXT)`,
  jsonExtract: (column, path) => {
    assertJsonPath(path);
    return `((${column})::jsonb #>> '{${path.split('.').join(',')}}')`;
  },
  jsonArrayContains: (column, param) => `((${column})::jsonb @> (${param})::jsonb)`,
  forUpdate: () => ' FOR UPDATE',
  lockForWrite: (qb) => qb.setLock('pessimistic_write'),
};

const sqlite: Dialect = {
  sqlite: true,
  ilike: (column, param) => `LOWER(${column}) LIKE LOWER(${param})`,
  monthBucket: (column) => `strftime('%Y-%m', ${column})`,
  dayBucket: (column) => `strftime('%Y-%m-%d', ${column})`,
  now: () => 'CURRENT_TIMESTAMP',
  epochSeconds: (column) => `CAST(strftime('%s', ${column}) AS INTEGER)`,
  castText: (column) => `CAST(${column} AS TEXT)`,
  jsonExtract: (column, path) => {
    assertJsonPath(path);
    return `json_extract(${column}, '$.${path}')`;
  },
  jsonArrayContains: (column, param) =>
    `NOT EXISTS (SELECT 1 FROM json_each(${param}) AS _vx_wanted WHERE NOT EXISTS (SELECT 1 FROM json_each(${column}) AS _vx_have WHERE _vx_have.value = _vx_wanted.value))`,
  forUpdate: () => '',
  lockForWrite: (qb) => qb,
};

/** The dialect of a connection, from `DATABASE_ENGINE` / `DB__<NAME>__ENGINE` (default: the main connection). */
export function dialect(connection: string = MAIN_CONNECTION): Dialect {
  return isSqlite(connection) ? sqlite : postgres;
}

/** The dialect of a live DataSource / EntityManager connection (looks at the driver, not at the environment). */
export function dialectOf(dataSource: { options?: { type?: string } }): Dialect {
  return isSqliteDataSource(dataSource) ? sqlite : postgres;
}
