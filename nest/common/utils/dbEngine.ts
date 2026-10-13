/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Engine detection and portable column types.
 *
 * The engine is read from the environment of the process and is FIXED at startup:
 * entity decorators are evaluated at import time, so `jsonColumnType()` /
 * `timestampColumnType()` must see the final environment (load `.env` first).
 *
 * Lives in `common` (not `database`) so that `common` and `voice` entities can use it without linking the
 * `database` module; `database` re-exports it for its public API.
 */

/** Logical name of the default connection (NestJS default / unnamed). */
export const MAIN_CONNECTION = 'main';

/** Env prefix of a connection (`DB_` for main, `DB__<NAME>__` for a named one). */
export function connectionEnvPrefix(name: string): string {
  return name === MAIN_CONNECTION ? 'DB_' : `DB__${name.toUpperCase()}__`;
}

/** Read `<prefix><key>` for a connection; the main one also falls back to a legacy variable. */
export function readConnectionEnv(
  name: string,
  key: string,
  legacy?: string
): string | undefined {
  const isMain = name === MAIN_CONNECTION;
  return process.env[connectionEnvPrefix(name) + key] ?? (isMain && legacy ? process.env[legacy] : undefined);
}

/** Lower-cased engine of a connection (default `postgres`). */
export function resolveEngine(name: string = MAIN_CONNECTION): string {
  return (readConnectionEnv(name, 'ENGINE', 'DATABASE_ENGINE') ?? 'postgres').toLowerCase();
}

/** True when the given connection runs on SQLite. */
export function isSqlite(connection: string = MAIN_CONNECTION): boolean {
  return resolveEngine(connection) === 'sqlite';
}

/** Column type for JSON payloads: `jsonb` on Postgres, `simple-json` on SQLite. */
export function jsonColumnType(connection: string = MAIN_CONNECTION): 'jsonb' | 'simple-json' {
  return isSqlite(connection) ? 'simple-json' : 'jsonb';
}

/** Column type for timestamps: `timestamptz` on Postgres, `datetime` on SQLite. */
export function timestampColumnType(
  connection: string = MAIN_CONNECTION
): 'timestamptz' | 'datetime' {
  return isSqlite(connection) ? 'datetime' : 'timestamptz';
}

/** True when a TypeORM data source runs on SQLite (looks at the live driver, not at the environment). */
export function isSqliteDataSource(dataSource: { options?: { type?: string } }): boolean {
  const type = dataSource.options?.type;
  return type === 'better-sqlite3' || type === 'sqlite';
}

/**
 * Adapt a raw query written with Postgres placeholders (`$1`, `$2`, …) to SQLite, whose driver only accepts
 * positional `?`: each `$n` becomes `?` and the parameter list is re-ordered (a placeholder used twice
 * duplicates its value). Returns the input untouched on Postgres.
 */
export function portableQuery(
  sqlite: boolean,
  sql: string,
  params: readonly unknown[] = []
): [string, unknown[]] {
  if (!sqlite) return [sql, [...params]];
  const ordered: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    ordered.push(params[Number(index) - 1]);
    return '?';
  });
  return [text, ordered];
}
