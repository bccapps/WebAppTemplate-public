/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Logger } from '@nestjs/common';
import { getMetadataArgsStorage } from 'typeorm';
import { resolveEngine } from './dbEngine';

/**
 * Automatic Postgres → SQLite adaptation of entity metadata.
 *
 * An entity is written once, with Postgres column types (`jsonb`, `timestamptz`, `enum`, `array: true`, `bytea`…). When the engine
 * is SQLite (`DB_ENGINE=sqlite`) the `database` module calls `applyPortableColumnTypes()` while it builds the DataSource
 * options: every column / index / check / generation already registered by the entity decorators is rewritten in place, and every
 * decorator evaluated later is rewritten as it registers (TypeORM imports the entity files after the options are built).
 *
 * Under Postgres nothing is called and nothing is changed (`applyPortableColumnTypes('postgres')` returns an empty report).
 * The call is idempotent. Explicit helpers (`jsonColumnType()`, `timestampColumnType()`) keep working and are left untouched.
 *
 * What is NOT translated (no equivalent): Postgres-only SQL in queries (use `dbDialect.ts` / TypeORM `ILike()`), JSON querying inside
 * the column, row locks, schemas, `GIN`/partial-index tricks. `db-portability-check.mjs` reports what is left.
 */

const HOOKED = Symbol.for('vx.portableTypes.hooked');
const ADAPTED_DEFAULT = Symbol.for('vx.portableTypes.adaptedDefault');

/** Postgres type (lower-cased) → a type the SQLite driver of TypeORM accepts (directly or through its own mapping). */
const TYPE_MAP: Readonly<Record<string, string>> = {
  json: 'simple-json',
  jsonb: 'simple-json',
  enum: 'simple-enum',
  timestamptz: 'datetime',
  timestamp: 'datetime',
  'timestamp with time zone': 'datetime',
  'timestamp without time zone': 'datetime',
  timetz: 'time',
  'time with time zone': 'time',
  'time without time zone': 'time',
  bytea: 'blob',
  'character varying': 'varchar',
  bpchar: 'character',
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  float4: 'float',
  float8: 'double',
  bool: 'boolean',
  money: 'decimal',
  inet: 'varchar',
  cidr: 'varchar',
  macaddr: 'varchar',
  citext: 'varchar',
  name: 'varchar',
  ltree: 'varchar',
  interval: 'varchar',
  xml: 'text',
  tsvector: 'text',
  hstore: 'simple-json',
  point: 'text',
  geometry: 'text',
  geography: 'text',
  vector: 'text',
};

const DATETIME_TARGETS = new Set(['datetime', 'time']);

const UUID_V4_SQLITE =
  "(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))))";

/** The SQLite type for a Postgres column type, or `undefined` when it is already fine (or not a string type). */
export function mapPostgresType(type: unknown): string | undefined {
  if (typeof type !== 'string') return undefined;
  const key = type.trim().toLowerCase().replace(/\(\s*\d+\s*\)/, '').replace(/\s+/g, ' ');
  return TYPE_MAP[key];
}

const PG_ONLY_SQL = /::|\bILIKE\b|~\*?|\bANY\s*\(|@>|<@|->>?|#>>?|\bto_char\s*\(|\bjsonb?_[a-z_]+\s*\(/i;

/** `'[]'::jsonb`, `now()`, `gen_random_uuid()` … → an expression SQLite accepts as a column default. */
export function rewriteSqlDefault(expression: string, fromArray = false): string {
  let sql = expression.trim();
  if (!sql) return sql;
  if (/^(now\(\)|statement_timestamp\(\)|transaction_timestamp\(\)|clock_timestamp\(\)|current_timestamp(\(\d*\))?|localtimestamp(\(\d*\))?|timezone\(\s*'utc'\s*,\s*now\(\)\s*\))(\s*::[\w ]+)?$/i.test(sql)) {
    return 'CURRENT_TIMESTAMP';
  }
  if (/^(gen_random_uuid\(\)|uuid_generate_v4\(\))(\s*::[\w ]+)?$/i.test(sql)) return UUID_V4_SQLITE;
  sql = sql.replace(/::\s*[a-z_][a-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?(\[\])?/gi, '').trim();
  if (fromArray && /^('\{\}'|array\[\s*\])$/i.test(sql)) return "'[]'";
  if (/^(now\(\)|current_timestamp)$/i.test(sql)) return 'CURRENT_TIMESTAMP';
  // A literal (quoted string, number, boolean/null keyword) or an already-parenthesised expression is a valid SQLite default as is.
  if (/^('([^']|'')*'|-?\d+(\.\d+)?|true|false|null|current_timestamp|current_date|current_time)$/i.test(sql) || /^\(.*\)$/s.test(sql)) return sql;
  return `(${sql})`;
}

interface ColumnOptionsLike {
  type?: unknown;
  array?: boolean;
  default?: unknown;
  precision?: unknown;
  scale?: unknown;
  enum?: unknown;
  enumName?: unknown;
  withoutTimezone?: unknown;
  collation?: unknown;
  [key: string]: unknown;
}

/** Rewrites one column's options in place. Returns `true` when something changed. */
export function adaptColumnOptions(options: ColumnOptionsLike | undefined): boolean {
  if (!options) return false;
  let changed = false;
  const wasArray = options.array === true;
  let target: string | undefined;
  if (wasArray) {
    target = 'simple-json';
    delete options.array;
  } else {
    target = mapPostgresType(options.type);
  }
  if (target && options.type !== target) {
    options.type = target;
    changed = true;
  }
  if (typeof options.type === 'string' && DATETIME_TARGETS.has(options.type)) {
    for (const key of ['precision', 'withoutTimezone'] as const) {
      if (key in options) {
        delete options[key];
        changed = true;
      }
    }
  }
  if (options.type === 'simple-enum' && options.enumName !== undefined) {
    delete options.enumName;
    changed = true;
  }
  if (options.collation !== undefined && typeof options.type === 'string' && /^(json|simple-json|datetime|integer|boolean)$/.test(options.type)) {
    delete options.collation;
    changed = true;
  }
  if (typeof options.default === 'function' && !(options.default as unknown as Record<symbol, unknown>)[ADAPTED_DEFAULT]) {
    const original = options.default as () => string;
    const adapted = (): string => {
      const raw = original();
      return typeof raw === 'string' ? rewriteSqlDefault(raw, wasArray) : raw;
    };
    (adapted as unknown as Record<symbol, unknown>)[ADAPTED_DEFAULT] = true;
    options.default = adapted;
    changed = true;
  }
  return changed;
}

export interface PortableTypesReport {
  /** `false` when the engine is not SQLite: nothing was touched. */
  active: boolean;
  columns: number;
  indices: number;
  checks: number;
  tables: number;
  /** Indices dropped because their definition cannot exist on SQLite. */
  droppedIndices: string[];
  /** Columns adapted, by resulting type (e.g. `{ 'simple-json': 12, datetime: 30 }`). */
  byType: Record<string, number>;
}

const totals: PortableTypesReport = { active: false, columns: 0, indices: 0, checks: 0, tables: 0, droppedIndices: [], byType: {} };
let summaryTimer: NodeJS.Timeout | undefined;

function emptyReport(active: boolean): PortableTypesReport {
  return { active, columns: 0, indices: 0, checks: 0, tables: 0, droppedIndices: [], byType: {} };
}

function count(report: PortableTypesReport, key: 'columns' | 'indices' | 'checks' | 'tables', by?: string): void {
  report[key] += 1;
  totals[key] += 1;
  if (by) {
    report.byType[by] = (report.byType[by] ?? 0) + 1;
    totals.byType[by] = (totals.byType[by] ?? 0) + 1;
  }
}

/** One `[DB] SQLite: adapted …` line per burst of registrations (TypeORM imports entities in a loop). */
function scheduleSummary(): void {
  if (process.env.DB_PORTABLE_LOG === 'false') return;
  if (summaryTimer) clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => {
    summaryTimer = undefined;
    const types = Object.entries(totals.byType).map(([type, n]) => `${type}×${n}`).join(', ');
    new Logger('PortableTypes').log(
      `[DB] SQLite: adapted ${totals.columns} column(s) (${types || 'none'}), ${totals.indices} index(es), ${totals.checks} check(s)` +
        (totals.droppedIndices.length ? `; dropped index(es): ${totals.droppedIndices.join(', ')}` : '')
    );
  }, 300);
  summaryTimer.unref();
}

interface IndexArgsLike {
  name?: string;
  unique?: boolean;
  where?: string;
  concurrent?: boolean;
  spatial?: boolean;
  fulltext?: boolean;
  parser?: string;
  sparse?: boolean;
  background?: boolean;
  [key: string]: unknown;
}

/** `true` = keep the index (possibly adjusted in place). */
function adaptIndex(index: IndexArgsLike, report: PortableTypesReport): boolean {
  let changed = false;
  for (const key of ['concurrent', 'spatial', 'fulltext', 'parser', 'sparse', 'background'] as const) {
    if (index[key] !== undefined) {
      delete index[key];
      changed = true;
    }
  }
  if (typeof index.where === 'string') {
    const stripped = index.where.replace(/::\s*[a-z_][a-z0-9_ ]*(\(\s*\d+\s*\))?(\[\])?/gi, '');
    if (PG_ONLY_SQL.test(stripped)) {
      // A partial UNIQUE index without its condition would reject rows the real schema accepts: drop it rather than over-constrain.
      if (index.unique) {
        report.droppedIndices.push(index.name ?? '(unnamed)');
        totals.droppedIndices.push(index.name ?? '(unnamed)');
        return false;
      }
      delete index.where;
      changed = true;
    } else if (stripped !== index.where) {
      index.where = stripped;
      changed = true;
    }
  }
  if (changed) count(report, 'indices');
  return true;
}

interface CheckArgsLike {
  expression?: string;
  name?: string;
}

function adaptCheck(check: CheckArgsLike, report: PortableTypesReport): boolean {
  if (typeof check.expression !== 'string') return true;
  const stripped = check.expression.replace(/::\s*[a-z_][a-z0-9_ ]*(\(\s*\d+\s*\))?(\[\])?/gi, '');
  if (PG_ONLY_SQL.test(stripped)) {
    report.droppedIndices.push(`check:${check.name ?? '(unnamed)'}`);
    totals.droppedIndices.push(`check:${check.name ?? '(unnamed)'}`);
    return false;
  }
  if (stripped !== check.expression) {
    check.expression = stripped;
    count(report, 'checks');
  }
  return true;
}

function hook<T>(list: T[], keep: (item: T) => boolean): void {
  const flagged = list as unknown as Record<symbol, unknown>;
  if (flagged[HOOKED]) return;
  Object.defineProperty(list, HOOKED, { value: true, enumerable: false });
  const push = list.push.bind(list);
  list.push = (...items: T[]): number => push(...items.filter(keep));
}

function sweep<T>(list: T[], keep: (item: T) => boolean): void {
  for (let i = list.length - 1; i >= 0; i -= 1) if (!keep(list[i] as T)) list.splice(i, 1);
}

/**
 * Adapts everything the entity decorators registered so far, and installs the hooks that adapt what they register next.
 * Only acts when `engine` is `sqlite` (default: the engine of the main connection). Safe to call any number of times.
 */
export function applyPortableColumnTypes(engine: string = resolveEngine()): PortableTypesReport {
  if (engine !== 'sqlite') return emptyReport(false);
  totals.active = true;
  const report = emptyReport(true);
  const storage = getMetadataArgsStorage();

  const keepColumn = (column: { options?: ColumnOptionsLike }): boolean => {
    if (adaptColumnOptions(column.options)) count(report, 'columns', typeof column.options?.type === 'string' ? column.options.type : 'default');
    return true;
  };
  const keepIndex = (index: IndexArgsLike): boolean => adaptIndex(index, report);
  const keepCheck = (check: CheckArgsLike): boolean => adaptCheck(check, report);
  const keepGeneration = (generation: { strategy?: string }): boolean => {
    if (generation.strategy === 'identity') generation.strategy = 'increment';
    return true;
  };
  const keepTable = (table: { schema?: string; options?: { schema?: string } }): boolean => {
    if (table.schema !== undefined) {
      delete table.schema;
      count(report, 'tables');
    }
    return true;
  };

  sweep(storage.columns as unknown as Array<{ options?: ColumnOptionsLike }>, keepColumn);
  sweep(storage.indices as unknown as IndexArgsLike[], keepIndex);
  sweep(storage.checks as unknown as CheckArgsLike[], keepCheck);
  sweep(storage.generations as unknown as Array<{ strategy?: string }>, keepGeneration);
  sweep(storage.tables as unknown as Array<{ schema?: string }>, keepTable);
  hook(storage.columns as unknown as Array<{ options?: ColumnOptionsLike }>, keepColumn);
  hook(storage.indices as unknown as IndexArgsLike[], keepIndex);
  hook(storage.checks as unknown as CheckArgsLike[], keepCheck);
  hook(storage.generations as unknown as Array<{ strategy?: string }>, keepGeneration);
  hook(storage.tables as unknown as Array<{ schema?: string }>, keepTable);

  if (report.columns + report.indices + report.checks + report.tables > 0) scheduleSummary();
  return report;
}

/** Counters since the process started (for tests and diagnostics). */
export function portableTypesTotals(): Readonly<PortableTypesReport> {
  return totals;
}
