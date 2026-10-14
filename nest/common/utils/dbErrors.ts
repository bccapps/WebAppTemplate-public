/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

function driverCodes(error: unknown): unknown[] {
  if (typeof error !== 'object' || error === null) return [];
  return [Reflect.get(error, 'code'), Reflect.get(Reflect.get(error, 'driverError') ?? {}, 'code')];
}

/**
 * A unique-constraint violation, whichever engine raised it: Postgres `23505`, SQLite (better-sqlite3)
 * `SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_CONSTRAINT_PRIMARYKEY`. TypeORM wraps the driver error in a `QueryFailedError` that
 * copies `code` (Postgres) or keeps the driver error as `driverError`.
 */
export function isUniqueViolation(error: unknown): boolean {
  return driverCodes(error).some((code) => code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY');
}

/** A foreign-key violation, whichever engine raised it (Postgres `23503`, SQLite `SQLITE_CONSTRAINT_FOREIGNKEY`). */
export function isForeignKeyViolation(error: unknown): boolean {
  return driverCodes(error).some((code) => code === '23503' || code === 'SQLITE_CONSTRAINT_FOREIGNKEY');
}

/** A NOT NULL violation, whichever engine raised it (Postgres `23502`, SQLite `SQLITE_CONSTRAINT_NOTNULL`). */
export function isNotNullViolation(error: unknown): boolean {
  return driverCodes(error).some((code) => code === '23502' || code === 'SQLITE_CONSTRAINT_NOTNULL');
}
