/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Data part of `pg-to-sqlite.mjs`, run INSIDE the app (cwd = the back directory, ts-node + tsconfig-paths registered):
 * copies every table of a PostgreSQL database into a new SQLite file whose schema is built from the app's own entities
 * (`src/config/Datasource`, engine forced to sqlite, so the automatic Postgres -> SQLite column adaptation applies).
 *
 * Values are not converted by hand: each Postgres value is handed to the TypeORM SQLite driver (`preparePersistentValue`), the same
 * code that writes a row at runtime, so dates, JSON, booleans, arrays and enums are stored exactly as the app will read them.
 * Column transformers are NOT applied (the Postgres value is already in its stored form).
 *
 * Source: PG_SOURCE_URL or PG_SOURCE_HOST/PORT/USER/PASSWORD/NAME (+ PG_SOURCE_SSL=1, PG_SOURCE_SCHEMA, default public).
 * `timestamp WITHOUT time zone` columns carry no zone: PG_SOURCE_NAIVE_TZ=utc (default) reads them as UTC, `local` as the local time of
 * this process (what node-pg does by default). Pick the zone the app that wrote them ran in (a container is normally UTC).
 * Target: DB_PATH (must not exist unless PG_TO_SQLITE_FORCE=1). PG_TO_SQLITE_DRY_RUN=1 only reads and compares nothing is written.
 *
 * Verification, per table: row count, SHA-256 of the ordered primary keys, and a decoded comparison of the first rows (what the
 * app reads back from SQLite must equal what Postgres returned). Exit code 1 on any mismatch. Prints one line prefixed `__VX_PG2SQLITE__`.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const need = (name) => require(require.resolve(name, { paths: [root] }));

const env = process.env;
const targetPath = path.resolve(root, env.DB_PATH || '');
const force = env.PG_TO_SQLITE_FORCE === '1';
const dryRun = env.PG_TO_SQLITE_DRY_RUN === '1';
const pgSchema = env.PG_SOURCE_SCHEMA || 'public';
const naiveUtc = (env.PG_SOURCE_NAIVE_TZ || 'utc').toLowerCase() !== 'local';
const SAMPLE_ROWS = 25;
const PAGE_SIZE = 1000;

const report = { target: targetPath, schema: pgSchema, naiveTimestampsAs: naiveUtc ? 'utc' : 'local', naiveTimestampColumns: [], tables: [], skipped: [], ignoredSourceTables: [], failures: [], integrity: null, foreignKeyViolations: 0 };

function fail(message) {
  report.failures.push(message);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function quote(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

/** Comparable form of a decoded value: dates as ms, buffers as hex, numbers/bigints as strings, objects as sorted JSON. */
function canonical(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return `d:${value.getTime()}`;
  if (Buffer.isBuffer(value)) return `b:${value.toString('hex')}`;
  if (typeof value === 'boolean') return `n:${value ? 1 : 0}`;
  if (typeof value === 'number' || typeof value === 'bigint') return `n:${Number(value)}`;
  if (typeof value === 'string') return /^-?\d+(\.\d+)?$/.test(value) ? `n:${Number(value)}` : `s:${value}`;
  return `j:${JSON.stringify(sortKeys(value))}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

function sourceConfig() {
  const ssl = env.PG_SOURCE_SSL === '1' ? { rejectUnauthorized: false } : false;
  if (env.PG_SOURCE_URL) return { connectionString: env.PG_SOURCE_URL, ssl };
  return {
    host: env.PG_SOURCE_HOST,
    port: Number(env.PG_SOURCE_PORT || 5432),
    user: env.PG_SOURCE_USER,
    password: env.PG_SOURCE_PASSWORD,
    database: env.PG_SOURCE_NAME,
    ssl,
  };
}

/** `date` stays a string (a JS Date would apply the local time zone); `timestamp` without zone follows PG_SOURCE_NAIVE_TZ. */
function pgTypes(pg) {
  return {
    getTypeParser(oid, format) {
      if (oid === 1082) return (text) => text;
      if (oid === 1114 && naiveUtc) return (text) => (/^-?infinity$/.test(text) ? null : new Date(`${text.replace(' ', 'T')}Z`));
      return pg.types.getTypeParser(oid, format);
    },
  };
}

async function main() {
  require(require.resolve('reflect-metadata', { paths: [root] }));
  const pg = need('pg');
  const { DataSource } = need('typeorm');

  if (!env.DB_PATH) throw new Error('DB_PATH (the SQLite target) is required');
  if (!dryRun && fs.existsSync(targetPath)) {
    if (!force) throw new Error(`${targetPath} already exists (refusing to overwrite; PG_TO_SQLITE_FORCE=1 replaces it)`);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(targetPath + suffix, { force: true });
  }
  if (!dryRun) fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const appDataSource = require(path.join(root, 'src/config/Datasource')).default;
  const options = { ...appDataSource.options, synchronize: !dryRun, migrationsRun: false, migrations: [] };
  if (dryRun) {
    options.database = ':memory:';
    options.synchronize = true;
  }
  const sqlite = new DataSource(options);
  await sqlite.initialize();
  const driver = sqlite.driver;
  const client = new pg.Client({ ...sourceConfig(), types: pgTypes(pg) });
  await client.connect();

  try {
    await sqlite.query('PRAGMA foreign_keys = OFF');
    const present = new Map();
    const columnRows = await client.query(
      'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position',
      [pgSchema]
    );
    for (const row of columnRows.rows) {
      if (!present.has(row.table_name)) present.set(row.table_name, new Set());
      present.get(row.table_name).add(row.column_name);
    }

    const naive = await client.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND data_type = 'timestamp without time zone' ORDER BY 1, 2",
      [pgSchema]
    );
    report.naiveTimestampColumns = naive.rows.map((row) => `${row.table_name}.${row.column_name}`);

    const handled = new Set();
    for (const metadata of sqlite.entityMetadatas) {
      if (metadata.tableType === 'view' || metadata.tableType === 'entity-child') continue;
      const table = metadata.tableName;
      if (handled.has(table)) continue;
      handled.add(table);
      const sourceColumns = present.get(table);
      if (!sourceColumns) {
        report.skipped.push({ table, reason: 'missing in the source database' });
        continue;
      }
      await copyTable({ metadata, table, sourceColumns, client, sqlite, driver });
    }
    for (const table of present.keys()) {
      if (!handled.has(table)) report.ignoredSourceTables.push(table);
    }

    if (!dryRun) {
      const integrity = await sqlite.query('PRAGMA integrity_check');
      report.integrity = integrity.map((row) => Object.values(row)[0]).join(',');
      if (report.integrity !== 'ok') fail(`SQLite integrity_check: ${report.integrity}`);
      const violations = await sqlite.query('PRAGMA foreign_key_check');
      report.foreignKeyViolations = violations.length;
      if (violations.length) {
        const first = violations.slice(0, 5).map((v) => `${v.table}#${v.rowid}->${v.parent}`).join(', ');
        fail(`${violations.length} foreign key violation(s) in the copied data (e.g. ${first})`);
      }
      await sqlite.query('PRAGMA wal_checkpoint(TRUNCATE)');
    }
  } finally {
    await client.end();
    await sqlite.destroy();
  }
}

async function copyTable({ metadata, table, sourceColumns, client, sqlite, driver }) {
  const columns = metadata.columns.filter((column) => !column.isVirtual && sourceColumns.has(column.databaseName));
  const missing = metadata.columns.filter((column) => !column.isVirtual && !sourceColumns.has(column.databaseName)).map((column) => column.databaseName);
  const extra = [...sourceColumns].filter((name) => !metadata.columns.some((column) => column.databaseName === name));
  const primary = metadata.primaryColumns.filter((column) => sourceColumns.has(column.databaseName));
  const orderBy = (primary.length ? primary : columns.slice(0, 1)).map((column) => quote(column.databaseName)).join(', ');
  const from = `${quote(pgSchema)}.${quote(table)}`;
  const entry = { table, sourceRows: 0, copiedRows: 0, sampled: 0, missingColumns: missing, extraSourceColumns: extra };

  const total = Number((await client.query(`SELECT COUNT(*) AS n FROM ${from}`)).rows[0].n);
  entry.sourceRows = total;
  const sourceKeys = [];
  const sample = [];
  const insertSql = `INSERT INTO ${quote(table)} (${columns.map((c) => quote(c.databaseName)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  // Transformers describe entity <-> stored value; the Postgres value is already the stored one, so the driver must not apply them.
  const plain = columns.map((column) => {
    if (!column.transformer) return column;
    const copy = Object.create(column);
    copy.transformer = undefined;
    return copy;
  });

  for (let offset = 0; offset < total || (total === 0 && offset === 0); offset += PAGE_SIZE) {
    if (total === 0) break;
    const page = await client.query(`SELECT * FROM ${from} ORDER BY ${orderBy} LIMIT ${PAGE_SIZE} OFFSET ${offset}`);
    const batch = page.rows.map((row) => columns.map((column, index) => driver.preparePersistentValue(row[column.databaseName], plain[index])));
    if (!dryRun) {
      const statement = driver.databaseConnection.prepare(insertSql);
      try {
        driver.databaseConnection.transaction((rows) => {
          for (const values of rows) statement.run(...values);
        })(batch);
      } catch (error) {
        throw new Error(`${table}: ${error.message}`);
      }
    }
    for (const row of page.rows) {
      sourceKeys.push(primary.map((column) => String(row[column.databaseName])).join('|'));
      if (sample.length < SAMPLE_ROWS) sample.push(row);
    }
    entry.copiedRows += page.rows.length;
  }

  if (!dryRun) {
    const count = Number((await sqlite.query(`SELECT COUNT(*) AS n FROM ${quote(table)}`))[0].n);
    if (count !== total) fail(`${table}: ${total} source row(s), ${count} copied`);
    if (primary.length) {
      const keys = primary.map((column) => quote(column.databaseName)).join(', ');
      const storedKeys = (await sqlite.query(`SELECT ${keys} FROM ${quote(table)}`)).map((row) => primary.map((column) => String(row[column.databaseName])).join('|'));
      const digest = (list) => crypto.createHash('sha256').update([...list].sort().join('\n')).digest('hex');
      entry.pkDigest = digest(storedKeys) === digest(sourceKeys) ? 'match' : 'MISMATCH';
      if (entry.pkDigest !== 'match') fail(`${table}: the set of primary keys differs between Postgres and SQLite`);
    }
    entry.sampled = await compareSample({ sqlite, driver, columns, primary, table, sample, entry });
  }
  report.tables.push(entry);
  log(`  ${table}: ${entry.copiedRows}/${total} row(s)${missing.length ? `, defaults for ${missing.join(',')}` : ''}`);
}

/** What the app reads back from SQLite must equal what Postgres returned, for the first rows of the table. */
async function compareSample({ sqlite, driver, columns, primary, table, sample, entry }) {
  if (!sample.length || !primary.length) return 0;
  let compared = 0;
  for (const source of sample) {
    const where = primary.map((column) => `${quote(column.databaseName)} = ?`).join(' AND ');
    const keyValues = primary.map((column) => driver.preparePersistentValue(source[column.databaseName], Object.assign(Object.create(column), { transformer: undefined })));
    const stored = (await sqlite.query(`SELECT * FROM ${quote(table)} WHERE ${where}`, keyValues))[0];
    if (!stored) {
      fail(`${table}: sampled row ${primary.map((c) => source[c.databaseName]).join('|')} not found after the copy`);
      continue;
    }
    for (const column of columns) {
      const decoded = driver.prepareHydratedValue(stored[column.databaseName], Object.assign(Object.create(column), { transformer: undefined }));
      if (canonical(decoded) !== canonical(source[column.databaseName])) {
        fail(`${table}.${column.databaseName}: Postgres ${canonical(source[column.databaseName]).slice(0, 80)} != SQLite ${canonical(decoded).slice(0, 80)}`);
        entry.mismatch = true;
        break;
      }
    }
    compared += 1;
  }
  return compared;
}

main()
  .then(() => {
    process.stdout.write(`__VX_PG2SQLITE__${JSON.stringify(report)}\n`);
    process.exitCode = report.failures.length ? 1 : 0;
  })
  .catch((error) => {
    report.failures.push(String(error && error.message ? error.message : error));
    process.stdout.write(`__VX_PG2SQLITE__${JSON.stringify(report)}\n`);
    process.exitCode = 2;
  });
