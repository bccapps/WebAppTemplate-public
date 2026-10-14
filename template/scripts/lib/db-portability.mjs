/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Static part of the database portability check (`db-portability-check.mjs`): finds SQL written for Postgres only in a project's
 * TypeScript sources, and counts the entity column types that the SQLite normaliser adapts on its own.
 *
 * A finding is an ERROR (no automatic translation: use `nest/common/utils/dbDialect.ts`, TypeORM's `ILike()` or a portable
 * expression) or a NOTE (adapted automatically on SQLite, nothing to do). A line is exempted by a comment on the same line or the
 * line above: `// pg-only: <reason>` (the reason is mandatory).
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * [rule, regex, severity, hint, scope]. Regexes run on one line of source (comment-only lines are skipped); scope `'string'`
 * (default) matches inside quotes/backticks only (SQL lives in strings), `'code'` matches the whole line (TypeORM methods).
 */
export const PG_RULES = [
  ['ILIKE', /\bILIKE\b/, 'error', "use TypeORM's ILike() operator or dbDialect().ilike(col, ':q')"],
  ['pg-cast', /[\w)\]'"]\s*::\s*(text|jsonb?|int2|int4|int8|integer|bigint|smallint|numeric|decimal|float4|float8|real|double|boolean|bool|date|time|timestamptz?|timestamp|uuid|varchar|character|char|bytea|regclass|interval|citext|inet)\b/i, 'error', 'a "::type" cast: use CAST(x AS type) or drop it'],
  ['jsonb-contains', /@>|<@/, 'error', 'jsonb containment: use dbDialect().jsonArrayContains() or filter in code'],
  ['json-arrow', /->>|#>>/, 'error', "jsonb operator: use dbDialect().jsonExtract(col, 'a.b')"],
  ['to_char', /\bto_char\s*\(/i, 'error', 'use dbDialect().monthBucket()/dayBucket()'],
  ['date_trunc', /\bdate_trunc\s*\(/i, 'error', 'use dbDialect().dayBucket()/monthBucket() or group in code'],
  ['extract-epoch', /\bEXTRACT\s*\(\s*EPOCH\b/i, 'error', 'use dbDialect().epochSeconds(col)'],
  ['returning', /\bRETURNING\b/, 'error', 'RETURNING is not available on SQLite: re-read the row, or count affected rows'],
  ['returning-qb', /\.returning\s*\(/, 'error', 'QueryBuilder.returning() is Postgres/MariaDB only: re-read the row, or count affected rows', 'code'],
  ['now', /(?<![.\w$])NOW\s*\(\s*\)/i, 'error', 'use dbDialect().now() (CURRENT_TIMESTAMP)'],
  ['any-array', /\bANY\s*\(/, 'error', 'use IN (:...ids)'],
  ['jsonb-fn', /\bjsonb?_[a-z_]+\s*\(/i, 'error', 'Postgres JSON function'],
  ['for-update', /\bFOR\s+UPDATE\b/, 'error', 'row locks do not exist on SQLite: use dbDialect().lockForWrite(qb)'],
  ['set-lock', /\.setLock\s*\(/, 'error', 'pessimistic locks throw on SQLite: use dbDialect().lockForWrite(qb)', 'code'],
  ['generate_series', /\bgenerate_series\s*\(/i, 'error', 'Postgres set-returning function'],
  ['distinct-on', /\bDISTINCT\s+ON\b/i, 'error', 'Postgres DISTINCT ON'],
  ['advisory-lock', /\bpg_(try_)?advisory[a-z_]*\s*\(/i, 'error', 'use CronLockService (it has an SQLite branch)'],
  ['interval', /\bINTERVAL\s+\\?['"]/i, 'error', 'Postgres interval literal: compute the date in code and bind it'],
  ['array-fn', /\bunnest\s*\(|\bARRAY\s*\[|\barray_(agg|append|length)\s*\(/i, 'error', 'Postgres arrays'],
  ['fulltext', /\bto_tsvector\s*\(|\bto_tsquery\s*\(|\bplainto_tsquery\s*\(/i, 'error', 'Postgres full-text search'],
  ['pg-uuid-fn', /\bgen_random_uuid\s*\(|\buuid_generate_v4\s*\(/i, 'note', 'generate the id in code (PrimaryGeneratedColumn("uuid") does)'],
];

/** Literal Postgres column types in entity decorators: adapted automatically on SQLite (counted, never failing). */
export const ENTITY_TYPE_RULES = [
  ['entity-jsonb', /type:\s*['"]jsonb?['"]/, 'jsonb → simple-json'],
  ['entity-timestamptz', /type:\s*['"](timestamptz|timestamp with time zone|timestamp)['"]/, 'timestamptz → datetime'],
  ['entity-enum', /type:\s*['"]enum['"]/, 'enum → simple-enum'],
  ['entity-array', /\barray:\s*true\b/, 'array → simple-json'],
  ['entity-bytea', /type:\s*['"]bytea['"]/, 'bytea → blob'],
];

const EXEMPT = /\/\/\s*pg-only\s*:\s*(\S.*)$/;
const EXEMPT_NO_REASON = /\/\/\s*pg-only\s*:?\s*$/;

function isCommentOnly(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Findings for one source file.
 * @param {string} text file content
 * @param {{ file?: string, isEntity?: boolean }} [options]
 * @returns {{ findings: Array<{file:string,line:number,rule:string,severity:string,text:string,hint:string}>, entityTypes: Record<string,number> }}
 */
export function scanText(text, { file = '<memory>', isEntity = false } = {}) {
  const lines = text.split('\n');
  const findings = [];
  const entityTypes = {};
  let inBlockComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.trim().startsWith('/*') && !line.includes('*/')) {
      inBlockComment = true;
      continue;
    }
    if (isCommentOnly(line)) continue;
    // API documentation strings (`description: '…ILIKE…'`) are prose, not SQL.
    if (/^\s*(description|summary|example|message)\s*:/.test(line)) continue;
    const exemption = EXEMPT.exec(line) ?? (index > 0 ? EXEMPT.exec(lines[index - 1]) : null);
    const bareExemption = EXEMPT_NO_REASON.test(line) || (index > 0 && EXEMPT_NO_REASON.test(lines[index - 1]));
    if (isEntity) {
      for (const [rule, regex] of ENTITY_TYPE_RULES) {
        if (regex.test(line)) entityTypes[rule] = (entityTypes[rule] ?? 0) + 1;
      }
    }
    // Only look at what is inside quotes or backticks (SQL lives in strings); a `::` in plain TS code is not SQL.
    // `${…}` of a template literal is code, not SQL text.
    const quoted = [...line.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((match) => match[2].replace(/\$\{[^}]*\}/g, ' ')).join(' ');
    const code = line.replace(EXEMPT, '');
    for (const [rule, regex, severity, hint, scope] of PG_RULES) {
      if (!regex.test(scope === 'code' ? code : quoted)) continue;
      // In an entity the defaults/indices written for Postgres are rewritten by the normaliser: informational only.
      const effective = isEntity && ['pg-cast', 'now', 'pg-uuid-fn', 'array-fn'].includes(rule) ? 'note' : severity;
      if (exemption) continue;
      findings.push({
        file,
        line: index + 1,
        rule: bareExemption ? `${rule} (pg-only exemption needs a reason)` : rule,
        severity: effective,
        text: line.trim().slice(0, 160),
        hint,
      });
    }
  }
  return { findings, entityTypes };
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.libs', 'migrations']);
const SPEC = /\.(spec|test|e2e-spec|sqlite-spec)\.ts$/;

/** `ts` files under `dir`, skipping tests, migrations and (unless `followShared`) symlinked shared modules. */
export function listSources(dir, { followShared = false } = {}) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink() && !followShared) continue;
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) isDir = lstatSync(full, { throwIfNoEntry: false }) !== undefined && existsSync(full) && readdirSafe(full) !== null;
      if (isDir) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !SPEC.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

const isEntityFile = (file) => /(^|[\\/])entities[\\/]/.test(file) || /\.entity\.ts$/.test(file);

/** Scans every source under `<root>/src`. */
export function scanTree(root, options = {}) {
  const srcDir = path.join(root, 'src');
  const files = existsSync(srcDir) ? listSources(srcDir, options) : [];
  const findings = [];
  const entityTypes = {};
  for (const file of files) {
    const result = scanText(readFileSync(file, 'utf8'), { file: path.relative(root, file), isEntity: isEntityFile(file) });
    findings.push(...result.findings);
    for (const [rule, n] of Object.entries(result.entityTypes)) entityTypes[rule] = (entityTypes[rule] ?? 0) + n;
  }
  return { files: files.length, findings, entityTypes };
}

/**
 * `databases` of a shared module (`module.json`), or `null` when it declares none (= every engine). A module that does not list
 * `sqlite` cannot run on SQLite: its entities are skipped by the schema check.
 */
export function moduleDatabases(moduleDir) {
  const file = path.join(moduleDir, 'module.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed.databases) ? parsed.databases.map((value) => String(value).toLowerCase()) : null;
  } catch {
    return null;
  }
}

/** Group findings by rule, top offenders first. */
export function summarize(findings) {
  const byRule = new Map();
  const byFile = new Map();
  for (const finding of findings) {
    if (finding.severity !== 'error') continue;
    byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1);
    byFile.set(finding.file, (byFile.get(finding.file) ?? 0) + 1);
  }
  const top = (map, n = 5) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return { errors: findings.filter((f) => f.severity === 'error').length, notes: findings.filter((f) => f.severity === 'note').length, topRules: top(byRule), topFiles: top(byFile) };
}
