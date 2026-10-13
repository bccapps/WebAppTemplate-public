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
 */

import { MAIN_CONNECTION } from './dbRouting';

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
