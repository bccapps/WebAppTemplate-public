/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * A timestamp read through a raw aggregate (`MAX(col)`, `getRawMany`, `getRawOne`): Postgres hands back a `Date` (or an ISO string
 * with its zone), SQLite a UTC string without zone (`2026-03-04 05:06:07.000`) that `new Date()` would read as LOCAL time.
 * Entities read through repositories are already hydrated by TypeORM and do not need this.
 */
export function parseDbDate(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
    return new Date(`${value.replace(' ', 'T')}Z`);
  }
  return new Date(value);
}

/** Same as {@link parseDbDate} for a value that may be `null`/`undefined` (an aggregate over zero rows). */
export function parseDbDateOrNull(value: Date | string | number | null | undefined): Date | null {
  return value === null || value === undefined ? null : parseDbDate(value);
}

/**
 * A numeric aggregate (`COUNT`, `SUM`, `AVG`) as a number: Postgres returns `bigint`/`numeric` aggregates as STRINGS, SQLite as
 * numbers; `null` (no rows) becomes `0`.
 */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
