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
 * Load test CLI (k6 + health monitoring + guards). Documentation: scripts/loadtest/README.md.
 *
 *   node scripts/loadtest/loadtest.mjs init
 *   node scripts/loadtest/loadtest.mjs plan [--tier <name>]
 *   node scripts/loadtest/loadtest.mjs check
 *   node scripts/loadtest/loadtest.mjs setup [--count N]
 *   node scripts/loadtest/loadtest.mjs probe            (one GET per journey step, to validate the paths)
 *   node scripts/loadtest/loadtest.mjs run --tier <name> [--tier <name>...] --confirm <api host>
 *   node scripts/loadtest/loadtest.mjs report <runId>
 *   node scripts/loadtest/loadtest.mjs teardown [--hard [--apply]]
 *   node scripts/loadtest/loadtest.mjs cloudflare <plan|allow|revoke>
 *
 * Options: --root <dir> (default: current directory), --config <file> (default: loadtest.config.json).
 * Nothing contacts a target except `check`, `setup`, `run`, `teardown` and `cloudflare allow|revoke`; `run` never
 * starts without `--confirm <host>` naming the API host, and never runs a tier that was not listed explicitly.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAdminClient, createUsers, issueMissingTokens, revokeAndRemove } from './lib/adminApi.mjs';
import { allowException, buildSkipRule, createCloudflareClient, revokeException, verifyToken } from './lib/cloudflare.mjs';
import { CONFIG_FILE, findTier, loadConfig } from './lib/config.mjs';
import { checkGuards, describeBreach } from './lib/guards.mjs';
import { hardDeleteUsers } from './lib/hardDelete.mjs';
import { isProbeFailure, probeJourneys } from './lib/probe.mjs';
import { estimateTier, planTier, planWarnings } from './lib/profile.mjs';
import { k6Digest, peaks, renderReport } from './lib/report.mjs';
import { BYPASS_HEADER, closeMonitors, loadRun, openMonitors, projectPaths, readJson, runTier, takeSample, writeSecretJson } from './lib/runner.mjs';
import { fmt, hostOf, isLocalHost, listFlag, loadEnvFile, parseArgs } from './lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (message = '') => console.log(message);
const fail = (message) => { console.error(`\x1b[1;31m✖\x1b[0m  ${message}`); process.exit(1); };

function context(args) {
  const root = path.resolve(args.flags.root ?? process.cwd());
  const paths = projectPaths(root);
  loadEnvFile(paths.secrets);
  return { root, paths, cfg: () => loadConfig(root, args.flags.config ?? CONFIG_FILE) };
}

function adminClientOf(cfg) {
  const token = process.env[cfg.auth.adminTokenEnv];
  if (!token) fail(`${cfg.auth.adminTokenEnv} is not set (export it or put it in .loadtest/secrets.env)`);
  return createAdminClient({ baseUrl: cfg.targets.api, token });
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function cmdInit({ root, paths }) {
  ensureDir(paths.dir);
  if (!existsSync(paths.secrets)) {
    writeFileSync(paths.secrets, readFileSync(path.join(HERE, 'secrets.env.example'), 'utf8'), { mode: 0o600 });
    log(`created ${path.relative(root, paths.secrets)} (fill it in; it is git-ignored)`);
  }
  const target = path.join(root, CONFIG_FILE);
  if (!existsSync(target)) { copyFileSync(path.join(HERE, 'loadtest.config.example.json'), target); log(`created ${CONFIG_FILE} (edit targets and journeys)`); }
  const ignore = path.join(root, '.gitignore');
  const current = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  if (!/^\.loadtest\/?$/m.test(current)) { writeFileSync(ignore, `${current}${current.endsWith('\n') || !current ? '' : '\n'}.loadtest/\n`); log('added .loadtest/ to .gitignore'); }
}

function cmdPlan({ cfg }, args) {
  const config = cfg();
  const names = listFlag(args.flags.tier);
  for (const tier of names.length ? names.map((n) => findTier(config, n)) : config.tiers) {
    const plan = planTier(config, tier);
    const est = estimateTier(config, plan);
    log(`\n[${tier.name}] ${plan.concurrent} sessions = ${plan.registered} registered + ${plan.anonymous} anonymous, ~${Math.round(plan.durationSec / 60)} min${tier.optional ? ' (optional)' : ''}`);
    log(`  traffic ≈ ${fmt(est.totalRps)} req/s (registered ${fmt(est.registeredRps)}, anonymous ${fmt(est.anonymousRps)}), ~${est.requestsTotal} requests`);
    log(`  redis   ≈ ${fmt(est.redisOpsPerSec, 0)} ops/s, ~${est.redisOpsTotal} commands over the tier`);
    for (const warning of planWarnings(config, plan, est)) log(`  ⚠  ${warning}`);
  }
}

async function cmdCheck({ root, paths, cfg }) {
  const config = cfg();
  const results = [];
  const add = (name, ok, detail = '') => { results.push(ok); log(`${ok ? '✓' : '✖'}  ${name}${detail ? ` — ${detail}` : ''}`); };
  const k6 = spawnSync('k6', ['version'], { encoding: 'utf8' });
  add('k6 installed', k6.status === 0, k6.status === 0 ? k6.stdout.trim() : 'install it: brew install k6');
  for (const [name, url] of Object.entries(config.targets)) {
    const probe = name === 'api' ? `${url}/health` : url;
    try { const r = await fetch(probe, { signal: AbortSignal.timeout(10000) }); add(`target ${name} reachable`, r.status < 500, `HTTP ${r.status}`); }
    catch (error) { add(`target ${name} reachable`, false, error.message); }
  }
  add(`admin token (${config.auth.adminTokenEnv})`, Boolean(process.env[config.auth.adminTokenEnv]), 'presence only, never sent by this check');
  const mon = await openMonitors(root, config, process.env, (m) => add('monitor', false, m));
  add('Prometheus configured', Boolean(mon.prom));
  add('Postgres sampler', Boolean(mon.pg) || !config.monitor.postgres.enabled);
  add('Redis sampler', Boolean(mon.redis) || !config.monitor.redis.enabled);
  if (mon.prom || mon.pg || mon.redis) {
    const sample = await takeSample(mon);
    const breaches = checkGuards(sample, config);
    add('baseline within guards', breaches.length === 0, breaches.map(describeBreach).join('; '));
  }
  await closeMonitors(mon);
  add('test accounts file', existsSync(paths.users), existsSync(paths.users) ? `${readJson(paths.users).length} accounts` : 'run `setup`');
  if (results.includes(false)) process.exitCode = 1;
}

async function cmdSetup({ paths, cfg }, args) {
  const config = cfg();
  if (args.flags.count) config.auth.userCount = Number(args.flags.count);
  const client = adminClientOf(config);
  ensureDir(paths.dir);
  const existing = existsSync(paths.users) ? readJson(paths.users) : [];
  const save = (_entry, users) => writeSecretJson(paths.users, users);
  const users = await createUsers(client, config.auth, existing, save);
  await issueMissingTokens(client, config.auth, users, save);
  writeSecretJson(paths.users, users);
  chmodSync(paths.users, 0o600);
  log(`${users.length} test accounts ready (${path.relative(process.cwd(), paths.users)}, mode 600). Remove them with: teardown`);
}

async function cmdProbe({ paths, cfg }) {
  const config = cfg();
  const token = existsSync(paths.users) ? readJson(paths.users)[0]?.token : null;
  let failures = 0;
  for (const kind of ['anonymous', 'registered']) {
    if (kind === 'registered' && !token) { log('registered journeys skipped: run `setup` first'); continue; }
    for (const row of await probeJourneys(config, { kind, token: kind === 'registered' ? token : null })) {
      if (isProbeFailure(row)) failures++;
      log(`${isProbeFailure(row) ? '✖' : '✓'}  [${kind}/${row.page}] ${row.status}${row.ms === null ? '' : ` ${row.ms}ms`}  ${row.url}`);
    }
  }
  if (failures) process.exitCode = 1;
}

function runIdOf(tiers) {
  return `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${tiers.map((t) => t.name).join('+')}`;
}

function preflightFail(config, args) {
  const host = hostOf(config.targets.api);
  if (!isLocalHost(host) && args.flags.confirm !== host) {
    return `refusing to run against ${host}: add --confirm ${host}`;
  }
  return null;
}

async function cmdRun({ root, paths, cfg }, args) {
  const config = cfg();
  const names = listFlag(args.flags.tier);
  if (!names.length) fail('run needs at least one explicit --tier <name> (see: plan)');
  const tiers = names.map((n) => findTier(config, n));
  const refusal = preflightFail(config, args);
  if (refusal) fail(refusal);
  if (spawnSync('k6', ['version']).status !== 0) fail('k6 is not installed (brew install k6)');
  if (config.model.mix.registered > 0 && !existsSync(paths.users)) fail('no test accounts: run `setup` first');
  const bypassKey = existsSync(paths.cloudflare) ? readJson(paths.cloudflare).secret : '';
  const mon = await openMonitors(root, config, process.env);
  const baseline = checkGuards(await takeSample(mon), config);
  if (baseline.length) { await closeMonitors(mon); fail(`baseline already above a guard: ${baseline.map(describeBreach).join('; ')}`); }
  const runId = runIdOf(tiers);
  const runDir = path.join(paths.runs, runId);
  mkdirSync(runDir, { recursive: true });
  log(`run ${runId} → ${path.relative(process.cwd(), runDir)}`);
  process.once('SIGINT', () => { log('\nInterrupted: k6 stops, artefacts so far are kept.'); });
  for (const [index, tier] of tiers.entries()) {
    log(`\n=== tier ${tier.name} (${tier.concurrent} sessions) ===`);
    const meta = await runTier({ cfg: config, tier, runDir, mon, usersFile: paths.users, bypassKey });
    if (meta.aborted) log(`tier ${tier.name} aborted: ${meta.abortReason}`);
    if (meta.aborted) break;
    if (index < tiers.length - 1) await new Promise((resolve) => setTimeout(resolve, config.monitor.cooldownSec * 1000));
  }
  await closeMonitors(mon);
  writeReport(runDir, config, runId);
}

function writeReport(runDir, config, runId) {
  const tiers = loadRun(runDir, config, { peaks, k6Digest });
  const file = path.join(runDir, 'report.md');
  writeFileSync(file, renderReport({ cfg: config, runId, tiers }));
  log(`\nreport: ${path.relative(process.cwd(), file)}`);
}

function cmdReport({ paths, cfg }, args) {
  const runId = args._[1];
  if (!runId) fail('usage: report <runId> (a folder of .loadtest/runs)');
  writeReport(path.join(paths.runs, runId), cfg(), runId);
}

async function cmdTeardown({ root, paths, cfg }, args) {
  const config = cfg();
  if (!existsSync(paths.users)) fail('no test accounts file: nothing to tear down');
  const users = readJson(paths.users);
  if (!args.flags.hard) {
    const result = await revokeAndRemove(adminClientOf(config), config.auth, users, (_user, r) => process.stdout.write(`\r${r.removed}/${users.length} removed`));
    log(`\nrevoked ${result.revoked}, removed ${result.removed}, failed ${result.failed.length}`);
    for (const f of result.failed) log(`  ✖ #${f.id}: ${f.error}`);
    const ids = users.filter((u) => !result.failed.some((f) => f.id === u.id)).map(({ id, nickname }) => ({ id, nickname }));
    writeSecretJson(paths.users, result.failed.length ? users : ids);
    return;
  }
  const mon = await openMonitors(root, { ...config, monitor: { ...config.monitor, postgres: { ...config.monitor.postgres, enabled: true } } }, process.env);
  if (!mon.pg) fail('Postgres is not reachable (see the message above)');
  try {
    const out = await hardDeleteUsers(mon.pg, config.auth, users.map((u) => u.id), { apply: Boolean(args.flags.apply) });
    for (const row of out.counts) log(`  ${row.table}: ${row.rows} row(s)`);
    log(out.applied ? 'hard delete COMMITTED' : 'dry run only (rolled back): add --apply to commit');
    if (out.applied) unlinkSync(paths.users);
  } finally { await closeMonitors(mon); }
}

async function cmdCloudflare({ paths, cfg }, args) {
  const config = cfg();
  const cf = config.cloudflare;
  if (!cf) fail('no "cloudflare" section in the config');
  const action = args._[1];
  if (action === 'plan') {
    log(JSON.stringify(buildSkipRule(BYPASS_HEADER, '<secret>'), null, 2));
    log(`\nApply it as the FIRST custom rule of zone ${cf.zone} (Security → WAF → Custom rules), header ${BYPASS_HEADER}.`);
    return;
  }
  const token = process.env[cf.tokenEnv];
  if (!token) fail(`${cf.tokenEnv} is not set`);
  const client = createCloudflareClient({ token });
  if (action === 'allow') {
    await verifyToken(client);
    const secret = randomBytes(24).toString('hex');
    const state = await allowException(client, { zone: cf.zone, headerName: BYPASS_HEADER, secret });
    ensureDir(paths.dir);
    writeSecretJson(paths.cloudflare, { ...state, secret });
    log(`exception added (rule ${state.ruleId}). REMOVE IT after the test: cloudflare revoke`);
  } else if (action === 'revoke') {
    if (!existsSync(paths.cloudflare)) fail('no recorded exception');
    await revokeException(client, readJson(paths.cloudflare));
    renameSync(paths.cloudflare, `${paths.cloudflare}.revoked`);
    log('exception removed');
  } else fail('usage: cloudflare <plan|allow|revoke>');
}

const COMMANDS = { init: cmdInit, plan: cmdPlan, check: cmdCheck, setup: cmdSetup, probe: cmdProbe, run: cmdRun, report: cmdReport, teardown: cmdTeardown, cloudflare: cmdCloudflare };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = COMMANDS[args._[0]];
  if (!command) fail(`usage: loadtest.mjs <${Object.keys(COMMANDS).join('|')}> [options] (see scripts/loadtest/README.md)`);
  try { await command(context(args), args); } catch (error) { fail(error.message); }
}

main();
