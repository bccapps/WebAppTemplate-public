#!/usr/bin/env node
/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Copies a PostgreSQL database into a new SQLite file (the schema comes from the app's own entities, see
 * `lib/pg-to-sqlite-run.cjs`). Run it from the project root:
 *
 *   node scripts/pg-to-sqlite.mjs --source-env back/.env.preprod --out back/data/app.db
 *   node scripts/pg-to-sqlite.mjs --source-url postgres://user:pass@localhost:55432/db --out /tmp/app.db [--force] [--dry-run]
 *
 *   --source-env <file>   read DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME (/ DB_SSLMODE) from an env file
 *   --source-url <url>    or give a connection URL
 *   --pg-schema <name>    schema to copy (default public)
 *   --out <file>          SQLite file to create (default: DB_PATH of the project, relative to back/)
 *   --naive-tz <utc|local> how to read `timestamp without time zone` columns (default utc: the zone of a container; `local` = this machine)
 *   --force               replace an existing target file
 *   --dry-run             read the source and build the SQLite schema in memory only (nothing written)
 *   --json                print the full report as JSON
 *
 * The source is only read. For production, restore a fresh `backup-db.sh` dump into a scratch Postgres and point --source-url at it
 * (docs: "PostgreSQL -> SQLite migration" in the project docs). Exit code 0 = every table verified, 1 = a check failed, 2 = could not run.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const options = { sourceEnv: null, sourceUrl: null, pgSchema: 'public', naiveTz: 'utc', out: null, force: false, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source-env') options.sourceEnv = argv[++i];
    else if (arg === '--source-url') options.sourceUrl = argv[++i];
    else if (arg === '--pg-schema') options.pgSchema = argv[++i];
    else if (arg === '--naive-tz') options.naiveTz = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

/** KEY=VALUE lines of an env file (quotes and inline comments stripped); no shell evaluation. */
export function readEnvFile(file) {
  const values = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!match) continue;
    let value = match[2].trim();
    const quoted = /^(["'])(.*?)\1/.exec(value);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

export function sourceEnvironment(options) {
  if (options.sourceUrl) return { PG_SOURCE_URL: options.sourceUrl };
  if (!options.sourceEnv) throw new Error('give --source-env <file> or --source-url <url>');
  const file = path.resolve(options.sourceEnv);
  if (!existsSync(file)) throw new Error(`env file not found: ${file}`);
  const env = readEnvFile(file);
  for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME']) if (!env[key]) throw new Error(`${key} is missing in ${file}`);
  const ssl = (env.DB_SSLMODE ?? '').toLowerCase();
  return {
    PG_SOURCE_HOST: env.DB_HOST,
    PG_SOURCE_PORT: env.DB_PORT ?? '5432',
    PG_SOURCE_USER: env.DB_USER,
    PG_SOURCE_PASSWORD: env.DB_PASSWORD ?? '',
    PG_SOURCE_NAME: env.DB_NAME,
    PG_SOURCE_SSL: ssl && !['disable', 'false', '0', 'off'].includes(ssl) ? '1' : '0',
  };
}

function render(report) {
  const out = [];
  for (const table of report.tables) out.push(`  ${table.pkDigest === 'MISMATCH' || table.mismatch ? '✖' : '✔'} ${table.table}: ${table.copiedRows}/${table.sourceRows}`);
  if (report.skipped.length) out.push(`Skipped (not in the source): ${report.skipped.map((s) => s.table).join(', ')}`);
  if (report.ignoredSourceTables.length) out.push(`Source tables without an entity (not copied): ${report.ignoredSourceTables.join(', ')}`);
  if (report.naiveTimestampColumns.length) {
    out.push(`Columns without a time zone, read as ${report.naiveTimestampsAs.toUpperCase()}: ${report.naiveTimestampColumns.join(', ')}`);
  }
  const rows = report.tables.reduce((sum, table) => sum + table.copiedRows, 0);
  out.push(`${report.tables.length} table(s), ${rows} row(s) -> ${report.target}`);
  if (report.integrity) out.push(`SQLite integrity_check: ${report.integrity}; foreign key violations: ${report.foreignKeyViolations}`);
  for (const failure of report.failures) out.push(`  ✖ ${failure}`);
  out.push(report.failures.length ? 'FAILED: do not use this SQLite file.' : 'OK: every table copied and verified.');
  return out.join('\n');
}

export function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: pg-to-sqlite.mjs (--source-env <file> | --source-url <url>) [--out <file>] [--pg-schema <name>] [--force] [--dry-run] [--json]');
    return 0;
  }
  const root = path.resolve('back');
  if (!existsSync(path.join(root, 'src'))) throw new Error('run it from the project root (back/src not found)');
  const target = options.out ? path.resolve(options.out) : path.resolve(root, process.env.DB_PATH ?? `data/${path.basename(path.resolve('.'))}.db`);
  const helper = path.join(here, 'lib', 'pg-to-sqlite-run.cjs');
  const result = spawnSync(
    process.execPath,
    ['--preserve-symlinks', '-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', helper],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: 'true',
        DB_ENGINE: 'sqlite',
        DB_PATH: target,
        DB_SCHEMA_MODE: 'sync',
        DB_PORTABLE_LOG: 'false',
        PG_SOURCE_SCHEMA: options.pgSchema,
        PG_SOURCE_NAIVE_TZ: options.naiveTz,
        PG_TO_SQLITE_FORCE: options.force ? '1' : '0',
        PG_TO_SQLITE_DRY_RUN: options.dryRun ? '1' : '0',
        ...sourceEnvironment(options),
      },
    }
  );
  const line = (result.stdout ?? '').split('\n').find((candidate) => candidate.startsWith('__VX_PG2SQLITE__'));
  if (!line) throw new Error(`the copy could not start: ${result.error?.message ?? 'no report printed (see the output above)'}`);
  const report = JSON.parse(line.slice('__VX_PG2SQLITE__'.length));
  console.log(options.json ? JSON.stringify(report, null, 2) : render(report));
  return result.status ?? 2;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
  }
}
