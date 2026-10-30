/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Runs ONE tier: starts k6, samples the health of every monitored system while it runs, stops k6 gracefully as soon
 * as a guard is crossed, and stores the artefacts of the tier (`plan.json`, `summary.json`, `samples.jsonl`,
 * `meta.json`) in the run directory.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkGuards, describeBreach } from './guards.mjs';
import { basicAuthHeader, sampleQueries } from './prometheus.mjs';
import { planTier, estimateTier } from './profile.mjs';
import { diffStatements, openPostgres, openRedis, sampleGenerator, samplePostgres, sampleRedis, snapshotStatements } from './samplers.mjs';
import { parseEnvFile, requireFromProject, sleep } from './util.mjs';

export const K6_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'k6', 'scenario.js');
export const BYPASS_HEADER = 'x-loadtest-key';

export function projectPaths(root) {
  const dir = path.join(root, '.loadtest');
  return { dir, users: path.join(dir, 'users.json'), secrets: path.join(dir, 'secrets.env'), runs: path.join(dir, 'runs'), cloudflare: path.join(dir, 'cloudflare.json') };
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const writeSecretJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });

/** Connection URL of the database: explicit variable first, else assembled from the back's `DB_*` variables. */
export function pgUrlFrom(env, fileEnv) {
  const explicit = env[fileEnv.urlEnv] ?? fileEnv.map?.DATABASE_URL;
  if (explicit) return explicit;
  const m = fileEnv.map ?? {};
  if (!m.DB_HOST) return null;
  const ssl = ['disable', 'false', '0', 'off', ''].includes(String(m.DB_SSLMODE ?? '').toLowerCase()) ? 'disable' : 'require';
  const auth = `${encodeURIComponent(m.DB_USER ?? '')}:${encodeURIComponent(m.DB_PASSWORD ?? '')}`;
  return `postgres://${auth}@${m.DB_HOST}:${m.DB_PORT ?? 5432}/${m.DB_NAME ?? ''}?sslmode=${ssl}`;
}

const envFileMap = (root, file) => (file && existsSync(path.join(root, file)) ? parseEnvFile(readFileSync(path.join(root, file), 'utf8')) : {});

/** Opens the configured monitors. Each one that cannot connect is reported and skipped, never fatal. */
export async function openMonitors(root, cfg, env, log = console.warn) {
  const mon = { prom: null, pg: null, redis: null, closers: [] };
  const prom = cfg.monitor.prometheus;
  if (prom?.url) {
    mon.prom = { ...prom, headers: basicAuthHeader(env[prom.userEnv ?? 'LOADTEST_PROM_USER'], env[prom.passwordEnv ?? 'LOADTEST_PROM_PASSWORD']) };
  }
  const { postgres: pgCfg, redis: redisCfg } = cfg.monitor;
  const attach = async (name, enabled, open) => {
    if (!enabled) return;
    try { mon[name] = await open(); } catch (error) { log(`monitor ${name} disabled: ${error.message}`); }
  };
  await attach('pg', pgCfg.enabled, async () => {
    const pgModule = requireFromProject(root, 'pg');
    if (!pgModule) throw new Error('`pg` not found in the project');
    const url = pgUrlFrom(env, { urlEnv: pgCfg.urlEnv, map: envFileMap(root, pgCfg.envFile) });
    if (!url) throw new Error(`no ${pgCfg.urlEnv} and no DB_HOST in ${pgCfg.envFile ?? 'envFile'}`);
    const client = await openPostgres(pgModule, url, pgCfg.verifySsl);
    mon.closers.push(() => client.end());
    return client;
  });
  await attach('redis', redisCfg.enabled, async () => {
    const IORedis = requireFromProject(root, 'ioredis');
    if (!IORedis) throw new Error('`ioredis` not found in the project');
    const url = env[redisCfg.urlEnv] ?? envFileMap(root, redisCfg.envFile).REDIS_URL;
    if (!url) throw new Error(`no ${redisCfg.urlEnv} and no REDIS_URL in ${redisCfg.envFile ?? 'envFile'}`);
    const client = await openRedis(IORedis, url);
    mon.closers.push(() => client.quit());
    return client;
  });
  return mon;
}

export async function closeMonitors(mon) {
  await Promise.all(mon.closers.map((close) => Promise.resolve(close()).catch(() => {})));
}

/** One health sample of everything monitored; a failing source yields `null` for that source only. */
export async function takeSample(mon) {
  const safe = (promise) => promise.catch(() => null);
  const [prom, pg, redis] = await Promise.all([
    mon.prom ? safe(sampleQueries(mon.prom, { headers: mon.prom.headers })) : null,
    mon.pg ? safe(samplePostgres(mon.pg)) : null,
    mon.redis ? safe(sampleRedis(mon.redis)) : null,
  ]);
  return { t: Date.now(), prom, pg, redis, gen: sampleGenerator() };
}

/** Cooperative stop of k6: SIGTERM, then SIGKILL after 60 s. */
function stopK6(child) {
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 60000).unref();
}

function k6Env(tierDir, usersFile, bypassKey) {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME,
    LOADTEST_CONFIG: path.join(tierDir, 'k6config.json'),
    LOADTEST_USERS: usersFile ?? '',
    LOADTEST_SUMMARY: path.join(tierDir, 'summary.json'),
    LOADTEST_BYPASS_KEY: bypassKey ?? '',
  };
}

function writeK6Config(cfg, plan, tierDir) {
  const { targets, headers, journeys, model, limits } = cfg;
  writeFileSync(path.join(tierDir, 'k6config.json'), JSON.stringify({ targets, headers, journeys, model, limits, plan, bypassHeader: BYPASS_HEADER }));
}

/**
 * Runs a tier and resolves with its meta. `deps` can override `spawnImpl` and `sleepImpl` (tests).
 */
export async function runTier({ cfg, tier, runDir, mon, usersFile, bypassKey, k6Bin = 'k6', log = console.log, deps = {} }) {
  const { spawnImpl = spawn } = deps;
  const tierDir = path.join(runDir, tier.name);
  mkdirSync(tierDir, { recursive: true });
  const plan = planTier(cfg, tier);
  const estimate = estimateTier(cfg, plan);
  writeFileSync(path.join(tierDir, 'plan.json'), JSON.stringify({ plan, estimate, pages: pageNames(cfg) }, null, 2));
  writeK6Config(cfg, plan, tierDir);

  const startRedis = mon.redis ? await sampleRedis(mon.redis).catch(() => null) : null;
  const before = mon.pg ? await snapshotStatements(mon.pg) : [];
  const meta = { startedAt: new Date().toISOString(), aborted: false, abortReason: '', breaches: [] };

  const child = spawnImpl(k6Bin, ['run', '--no-usage-report', K6_SCRIPT], { env: k6Env(tierDir, usersFile, bypassKey), stdio: ['ignore', 'inherit', 'inherit'] });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let exitCode = null;
  exited.then((code) => { exitCode = code; });

  const samplesFile = path.join(tierDir, 'samples.jsonl');
  while (exitCode === null) {
    await Promise.race([sleep(cfg.monitor.sampleSec * 1000), exited]);
    const sample = await takeSample(mon);
    appendFileSync(samplesFile, `${JSON.stringify(sample)}\n`);
    const breaches = checkGuards(sample, cfg);
    if (breaches.length && !meta.aborted) {
      meta.aborted = true;
      meta.abortReason = breaches.map(describeBreach).join('; ');
      meta.breaches = breaches;
      log(`\n!! GUARD CROSSED — stopping k6: ${meta.abortReason}`);
      stopK6(child);
    }
  }
  const endRedis = mon.redis ? await sampleRedis(mon.redis).catch(() => null) : null;
  if (startRedis && endRedis) meta.redisCommandsDelta = endRedis.totalCommands - startRedis.totalCommands;
  if (mon.pg) meta.statements = diffStatements(before, await snapshotStatements(mon.pg));
  Object.assign(meta, { endedAt: new Date().toISOString(), exitCode });
  if (exitCode === 99 && !meta.aborted) Object.assign(meta, { aborted: true, abortReason: 'k6 threshold (error rate or p95) crossed' });
  writeFileSync(path.join(tierDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export const pageNames = (cfg) => [...new Set(['registered', 'anonymous'].flatMap((k) => (cfg.journeys?.[k] ?? []).map((p) => p.name)))];

/** Reads the artefacts of every tier of a run directory, in tier order of the config. */
export function loadRun(runDir, cfg, { peaks, k6Digest }) {
  const tiers = [];
  for (const tier of cfg.tiers) {
    const dir = path.join(runDir, tier.name);
    if (!existsSync(path.join(dir, 'meta.json'))) continue;
    const { plan, estimate, pages } = readJson(path.join(dir, 'plan.json'));
    const summary = existsSync(path.join(dir, 'summary.json')) ? readJson(path.join(dir, 'summary.json')) : null;
    const samplesFile = path.join(dir, 'samples.jsonl');
    const samples = existsSync(samplesFile) ? readFileSync(samplesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    tiers.push({ plan, estimate, digest: k6Digest(summary, pages), peaks: peaks(samples), meta: readJson(path.join(dir, 'meta.json')) });
  }
  return tiers;
}
