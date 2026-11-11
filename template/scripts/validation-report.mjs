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
 * Validation by observation — analysis of the dev/preprod traces against the checks the modules declare
 * (`<module>/validation/checks.json`). Detail: `nest/common/README.md`, « Validation par observation ».
 *
 *   node scripts/validation-report.mjs                    dev: back/logs of this project
 *   node scripts/validation-report.mjs --preprod          preprod: fetch the traces (read-only SSH, fetch-preprod-validation-logs.mjs), then analyse
 *   node scripts/validation-report.mjs --logs <dir|archive.tar.gz>   logs provided by hand
 *   node scripts/validation-report.mjs --check-registry   validate every checks.json (CI gate)
 * Options: --since <30m|24h|7d|YYYY-MM-DD> --env dev|preprod --only <module> --json --follow-up (only the changes since
 * the last run; state in .validation-cache/, git-ignored) --no-fetch (with --preprod) --show-values (sample lines with
 * their scrubbed values; never with --preprod; default: field names only) --root <project> --state <file>.
 * Exit: 0 ok · 1 a VIOLATION of a critical/high check, a high-severity secret leak or a daily cap reached in the period ·
 * 2 usage or registry error · 3 preprod fetch or log reading failed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATUS, diffStates, evaluateChecks, isBlocking, toState, unknownTraces } from './lib/validation-evaluate.mjs';
import { listLogFiles, loadFingerprintKey, openLogSource, parseSince, readTraceLines, scanLeaks } from './lib/validation-logs.mjs';
import { discoverCheckFiles, loadRegistry } from './lib/validation-registry.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = '.validation-cache';
const FLAGS = new Set(['--preprod', '--no-fetch', '--json', '--follow-up', '--check-registry', '--show-values', '--help']);
const VALUES = new Set(['--root', '--logs', '--since', '--env', '--only', '--state']);

class UsageError extends Error {}

/** Parsed command line (throws UsageError). */
export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAGS.has(arg)) options[arg.slice(2)] = true;
    else if (VALUES.has(arg) && i + 1 < argv.length) options[arg.slice(2)] = argv[(i += 1)];
    else throw new UsageError(`unknown or incomplete option: ${arg}`);
  }
  if (options.env && !['dev', 'preprod'].includes(options.env)) throw new UsageError('--env must be dev or preprod');
  if (options.since !== undefined && parseSince(options.since) === null) throw new UsageError('--since: a duration (30m, 24h, 7d) or a date (YYYY-MM-DD)');
  if (options['show-values'] && (options.preprod || options.env === 'preprod')) throw new UsageError('--show-values is refused for preprod logs');
  return options;
}

/** `.validation-cache/` (0700) with its own `.gitignore` (`*`); refused when it is a symbolic link or not a directory. */
export function ensureCacheDir(root) {
  const dir = path.join(root, CACHE_DIR);
  let plain = true;
  try {
    plain = lstatSync(dir).isDirectory();
  } catch {
    /* absent: created below */
  }
  if (!plain) throw new UsageError(`${CACHE_DIR} is not a plain directory (symbolic link refused)`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignore = path.join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 });
  return dir;
}

function gitIgnores(root, target) {
  const result = spawnSync('git', ['-C', root, 'check-ignore', '-q', target], { stdio: 'ignore' });
  return result.status !== 1;
}

function fetchPreprod(root, options) {
  const args = [path.join(SCRIPT_DIR, 'fetch-preprod-validation-logs.mjs'), '--root', root, ...(options.since ? ['--since', options.since] : [])];
  const result = spawnSync(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  return result.status ?? 3;
}

function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const MAX_LEAKS_KEPT = 500;

/**
 * High and medium findings are kept one by one (first 500); low ones (shapes also common in harmless application logs:
 * hashes, long ids, outside the validation files) only as counts per type.
 */
function summarizeLeaks(all) {
  const leakCounts = { high: 0, medium: 0, low: 0 };
  const lowLeakShapes = {};
  for (const leak of all) {
    leakCounts[leak.severity] += 1;
    if (leak.severity !== 'low') continue;
    const shape = (lowLeakShapes[leak.type] ??= { count: 0, files: [] });
    shape.count += 1;
    if (!shape.files.includes(leak.file)) shape.files.push(leak.file);
  }
  return { leaks: all.filter((l) => l.severity !== 'low').slice(0, MAX_LEAKS_KEPT), leakCounts, lowLeakShapes };
}

function buildWarnings(root, source, files, stats, options) {
  const warnings = [];
  if (!existsSync(source)) warnings.push(`no log directory at ${path.relative(root, source) || source}: traces are written only with APP_ENV=dev (or preprod + VALIDATION_TRACE=on)`);
  else if (!files.length) warnings.push('the log directory is empty');
  if (stats.invalid) warnings.push(`${stats.invalid} unreadable line(s) in the validation files`);
  if (!options.preprod && !options.logs && existsSync(source) && !gitIgnores(root, source)) {
    warnings.push(`${path.relative(root, source)} is NOT ignored by git: add "logs/" to .gitignore`);
  }
  return warnings;
}

function blockingReasons(results, leakCounts, capped) {
  const reasons = results.filter(isBlocking).map((r) => `VIOLATION of ${r.severity} check ${r.id}`);
  if (leakCounts.high) reasons.push(`${leakCounts.high} high-severity secret leak(s) in the logs`);
  for (const cap of capped) reasons.push(`daily cap reached (${cap.traceClass}) in ${cap.file}: later traces of that class were not written`);
  return reasons;
}

/** Runs the whole analysis; returns { exitCode, report } (report = the JSON form). */
export async function analyse(options) {
  const root = path.resolve(options.root ?? process.cwd());
  const registry = loadRegistry(discoverCheckFiles(root));
  if (options['check-registry'] || registry.errors.length) {
    return { exitCode: registry.errors.length ? 2 : 0, report: { registry: { checks: registry.checks.length, errors: registry.errors } } };
  }
  loadFingerprintKey(ensureCacheDir(root));
  const env = options.env ?? (options.preprod ? 'preprod' : undefined);
  const source = options.preprod ? path.join(root, CACHE_DIR, 'preprod') : path.resolve(root, options.logs ?? path.join('back', 'logs'));
  const { dir, cleanup } = openLogSource(source);
  try {
    const files = listLogFiles(dir);
    const since = options.since ? parseSince(options.since) : null;
    const { lines, stats } = await readTraceLines(files, { since, env });
    const checks = registry.checks.filter((c) => !options.only || c.module === options.only);
    const results = evaluateChecks(checks, lines, { showValues: options['show-values'] === true });
    const { leaks, leakCounts, lowLeakShapes } = summarizeLeaks(await scanLeaks(files, dir));
    const blocking = blockingReasons(results, leakCounts, stats.capped);
    const report = {
      generatedAt: new Date().toISOString(), source: options.preprod ? 'preprod' : path.relative(root, source) || '.', env: env ?? 'any',
      since: since ? new Date(since).toISOString() : null, stats, registry: { checks: registry.checks.length, files: new Set(registry.checks.map((c) => c.file)).size },
      checks: results, unknownTraces: unknownTraces(checks, lines), leaks, leakCounts, lowLeakShapes, blocking, warnings: buildWarnings(root, source, files, stats, options),
    };
    return { exitCode: blocking.length ? 1 : 0, report };
  } finally {
    cleanup();
  }
}

const STATUS_ORDER = [STATUS.VIOLATION, STATUS.NOT_YET, STATUS.OK];
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

function formatCounts(c) {
  const pair = (label, p) => `${label}(back) ${p.back} · ${label}(front) ${p.front}`;
  return [pair('ok', c.ok), pair('info', c.info), pair('violation', c.violation), ...(c.forbidden.back + c.forbidden.front ? [pair('must-not-happen', c.forbidden)] : [])].join(' · ');
}

function formatResult(r) {
  const when = r.first ? ` · ${r.first} → ${r.last}` : '';
  const extra = [r.note, r.ignoredFront ? `${r.ignoredFront} front trace(s) ignored (check not declared "front")` : null].filter(Boolean);
  return [`  [${r.severity}] ${r.id} — ${r.title} · ${formatCounts(r.counts)}${when}`, ...extra.map((e) => `      note: ${e}`), ...r.samples.map((s) => `      › ${s}`)];
}

/** Findings grouped by value: one line per distinct secret (type + fingerprint, or type + length when short). */
function formatLeakGroups(leaks) {
  const groups = new Map();
  for (const leak of leaks) {
    if (!groups.has(leak.identity)) groups.set(leak.identity, { ...leak, places: [] });
    groups.get(leak.identity).places.push(`${leak.file}:${leak.line}`);
  }
  return [...groups.values()].slice(0, 40).map((g) => {
    const more = g.places.length > 3 ? ` (+${g.places.length - 3} more)` : '';
    return `  ${g.type}  ${g.fingerprint ? `${g.fingerprint} ` : ''}len=${g.length} ×${g.places.length}  [${g.severity}]  ${g.places.slice(0, 3).join(', ')}${more}`;
  });
}

function formatLeaks(report) {
  const { leakCounts: counts, lowLeakShapes: shapes } = report;
  const low = Object.entries(shapes).map(([type, s]) => `${type} ${s.count} in ${s.files.length} file(s)`).join(', ');
  const lowLine = low ? [`  low (not blocking, shapes common in application logs): ${low}`] : [];
  if (!counts.high && !counts.medium) return ['Secret leaks in logs: none', ...lowLine];
  return [`SECRET LEAKS IN LOGS: ${counts.high} high, ${counts.medium} medium, ${counts.low} low (values never shown)`, ...formatLeakGroups(report.leaks), ...lowLine];
}

/** Human-readable report. */
export function formatReport(report) {
  const { stats } = report;
  const out = [`Validation report — ${report.source} · env ${report.env}${report.since ? ` · since ${report.since}` : ''} · ${stats.files} file(s), ${stats.lines} trace line(s)`];
  out.push(`Registry: ${report.registry.checks} check(s) in ${report.registry.files} file(s)`);
  for (const status of STATUS_ORDER) {
    const group = report.checks.filter((r) => r.status === status).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    if (group.length) out.push('', `${status} (${group.length})`, ...group.flatMap(formatResult));
  }
  if (report.unknownTraces.length) out.push('', `Traces without a check: ${report.unknownTraces.slice(0, 20).map((t) => `${t.check} ×${t.count}`).join(', ')}`);
  out.push('', ...formatLeaks(report));
  for (const reason of report.blocking) out.push(`BLOCKING: ${reason}`);
  for (const warning of report.warnings) out.push(`Warning: ${warning}`);
  return out.join('\n');
}

function formatChange(change) {
  if (change.kind === 'status') return `  ${change.id}: ${change.from} → ${change.to}`;
  if (change.kind === 'more-violations') return `  ${change.id}: +${change.added} violation(s)`;
  if (change.kind === 'new-check') return `  ${change.id}: new check (${change.status})`;
  if (change.kind === 'removed-check') return `  ${change.id}: check removed from the registry`;
  return formatLeakGroups(change.leaks).map((line) => `  NEW LEAK ${line.trim()}`).join('\n');
}

/** `--follow-up` output: only what changed since the last run of the same source/env, then the state is saved. */
export function followUp(root, options, report) {
  const file = path.resolve(root, options.state ?? path.join(CACHE_DIR, 'report-state.json'));
  const all = loadState(file);
  const key = `${report.source}|${report.env}`;
  const previous = all[key];
  const changes = diffStates(previous, report.checks, report.leaks);
  all[key] = { runAt: report.generatedAt, ...toState(report.checks, report.leaks) };
  ensureCacheDir(root);
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  const open = report.checks.filter((r) => r.status === STATUS.VIOLATION).map((r) => r.id);
  const head = `Validation follow-up — ${report.source} · env ${report.env} · ${previous ? `since the run of ${previous.runAt}` : 'first run'}`;
  const body = changes.length ? changes.map(formatChange) : ['  no change'];
  const tail = [...(open.length ? [`  still open: ${open.length} violation(s) (${open.join(', ')})`] : []), ...report.blocking.filter((r) => r.startsWith('daily cap')).map((r) => `  ${r}`)];
  return [head, ...body, ...tail, ...report.warnings.map((w) => `Warning: ${w}`)].join('\n');
}

function printRegistry(report, json) {
  if (json) return console.log(JSON.stringify(report, null, 2));
  const { checks, errors } = report.registry;
  console.log(errors.length ? `checks.json: ${errors.length} error(s)\n${errors.map((e) => `  ${e}`).join('\n')}` : `checks.json: ${checks} check(s), all valid`);
}

async function run(options) {
  const root = path.resolve(options.root ?? process.cwd());
  if (options.preprod && !options['no-fetch'] && !options['check-registry']) {
    if (fetchPreprod(root, options) !== 0) {
      console.error('validation-report: the preprod fetch failed (see above); --no-fetch analyses the last copy in .validation-cache/preprod');
      return 3;
    }
  }
  const { exitCode, report } = await analyse({ ...options, root });
  if (!report.checks) printRegistry(report, options.json);
  else if (options['follow-up']) console.log(followUp(root, options, report));
  else console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return exitCode;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`validation-report: ${error.message} (see --help)`);
    return 2;
  }
  if (options.help) {
    const doc = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[1].split('/**')[1];
    console.log(doc.replace(/^ \* ?/gm, '').trim());
    return 0;
  }
  try {
    return await run(options);
  } catch (error) {
    console.error(`validation-report: ${error instanceof UsageError ? error.message : `cannot read the logs (${String(error?.message ?? error).split('\n')[0].slice(0, 200)})`}`);
    return error instanceof UsageError ? 2 : 3;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
