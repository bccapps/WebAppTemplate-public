/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Database portability check — can this app run on SQLite as well as on Postgres?
 *
 *   node .libs/apptemplate/scripts/db-portability-check.mjs [--root <back dir>] [--json] [--static-only | --schema-only]
 *                                                           [--include-postgres-only] [--include-shared]
 *   npm run db:check            (script contract of the template's back package)
 *
 * 1. Static scan of `.ts` files under `<root>/src` (tests, migrations and symlinked shared modules excluded) for SQL written for Postgres only
 *    (`ILIKE`, `::jsonb`, `@>`, `to_char`, `RETURNING`, `NOW()`, `FOR UPDATE`…). Each hit is an error unless the line (or the one above)
 *    carries `// pg-only: <reason>`. Literal Postgres column types in entities are only counted: the SQLite normaliser adapts them.
 * 2. Schema check: an in-memory SQLite DataSource is built from the app's entities (after the automatic adaptation) and synchronised;
 *    every entity/column the driver still refuses is listed. Shared modules whose `module.json` `databases` has no `sqlite` are skipped.
 *
 * Exit code 0 = no error, 1 = at least one error, 2 = the check itself could not run. `--json` prints one JSON document.
 * What is adapted automatically and what is not: `nest/common/utils/portableTypes.ts`, `nest/common/utils/dbDialect.ts`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTree, summarize } from './lib/db-portability.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const options = { root: process.cwd(), json: false, staticOnly: false, schemaOnly: false, includePostgresOnly: false, includeShared: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') options.root = path.resolve(argv[++i] ?? '');
    else if (arg === '--json') options.json = true;
    else if (arg === '--static-only') options.staticOnly = true;
    else if (arg === '--schema-only') options.schemaOnly = true;
    else if (arg === '--include-postgres-only') options.includePostgresOnly = true;
    else if (arg === '--include-shared') options.includeShared = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.staticOnly && options.schemaOnly) throw new Error('--static-only and --schema-only are exclusive');
  return options;
}

/** Runs the schema helper inside the app (ts-node). Returns its report, or a `failures` report when it could not run. */
export function runSchemaCheck(root, options) {
  const helper = path.join(here, 'lib', 'db-portability-schema.cjs');
  const result = spawnSync(
    process.execPath,
    ['--preserve-symlinks', '-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', helper],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', VX_DBCHECK_OPTIONS: JSON.stringify({ includePostgresOnly: options.includePostgresOnly }) },
    }
  );
  const line = (result.stdout ?? '').split('\n').find((candidate) => candidate.startsWith('__VX_DBCHECK__'));
  if (!line) {
    const detail = [result.error?.message, (result.stderr ?? '').trim().split('\n').slice(-6).join('\n')].filter(Boolean).join('\n');
    return { unavailable: true, failures: [{ stage: 'run', message: `the schema check could not start (ts-node and tsconfig-paths must be installed in ${root}):\n${detail}` }] };
  }
  return JSON.parse(line.slice('__VX_DBCHECK__'.length));
}

export function renderText(report) {
  const out = [];
  if (report.static) {
    const { static: scan } = report;
    out.push(`Static scan: ${scan.files} source file(s), ${scan.summary.errors} Postgres-only SQL finding(s), ${scan.summary.notes} note(s).`);
    for (const finding of scan.findings.filter((f) => f.severity === 'error')) {
      out.push(`  ✖ ${finding.file}:${finding.line}  [${finding.rule}]  ${finding.text}\n      → ${finding.hint}`);
    }
    const types = Object.entries(scan.entityTypes).map(([rule, n]) => `${rule.replace('entity-', '')}×${n}`).join(', ');
    if (types) out.push(`  ℹ entity columns adapted automatically on SQLite: ${types}`);
    if (scan.summary.topRules.length) out.push(`  top rules: ${scan.summary.topRules.map(([rule, n]) => `${rule}×${n}`).join(', ')}`);
  }
  if (report.schema) {
    const { schema } = report;
    out.push(`Schema check (in-memory SQLite): ${schema.entities} entit${schema.entities === 1 ? 'y' : 'ies'} in ${schema.modules?.length ?? 0} module(s), ${schema.failures.length} failure(s).`);
    for (const skipped of schema.skipped ?? []) out.push(`  – skipped module ${skipped.module}: ${skipped.reason}`);
    for (const failure of schema.failures) {
      out.push(failure.entity ? `  ✖ ${failure.entity}.${failure.column}  type "${failure.type}"${failure.module ? `  (module ${failure.module})` : ''}` : `  ✖ [${failure.stage}] ${failure.message.split('\n')[0]}`);
    }
  }
  out.push(report.ok ? 'OK: no blocking finding.' : 'FAILED: see above. Fix, or mark an intentional Postgres-only query with "// pg-only: <reason>".');
  return out.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: db-portability-check.mjs [--root <dir>] [--json] [--static-only|--schema-only] [--include-postgres-only] [--include-shared]');
    return 0;
  }
  if (!existsSync(path.join(options.root, 'src'))) throw new Error(`No src/ directory under ${options.root} (run from the back directory or pass --root)`);
  const report = {};
  if (!options.schemaOnly) {
    const scan = scanTree(options.root, { followShared: options.includeShared });
    report.static = { files: scan.files, findings: scan.findings, entityTypes: scan.entityTypes, summary: summarize(scan.findings) };
  }
  if (!options.staticOnly) report.schema = runSchemaCheck(options.root, options);
  const staticErrors = report.static?.summary.errors ?? 0;
  const schemaFailures = report.schema?.failures.length ?? 0;
  report.ok = staticErrors === 0 && schemaFailures === 0;
  console.log(options.json ? JSON.stringify(report, null, 2) : renderText(report));
  if (report.schema?.unavailable) return 2;
  return report.ok ? 0 : 1;
}

// Compared by real path: the project reaches this file through the `.libs/apptemplate` symlink, and Node resolves
// `import.meta.url` to the real file (without it `npm run db:check` silently did nothing).
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 2;
    }
  );
}
