/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { mergeConfig } from './config.mjs';
import { k6Digest } from './report.mjs';
import { peaks } from './report.mjs';
import { closeMonitors, loadRun, openMonitors, pageNames, pgUrlFrom, projectPaths, runTier, takeSample } from './runner.mjs';

const page = { name: 'home', weight: 1, requests: [{ path: '/x' }] };
const baseCfg = (over = {}) => mergeConfig({ targets: { api: 'https://a.io/api' }, journeys: { registered: [page], anonymous: [page] }, monitor: { sampleSec: 0.01 }, ...over });

test('projectPaths lives under .loadtest', () => {
  const p = projectPaths('/r');
  assert.equal(p.users, path.join('/r', '.loadtest', 'users.json'));
  assert.equal(p.runs, path.join('/r', '.loadtest', 'runs'));
});

test('pgUrlFrom: explicit URL, DATABASE_URL, assembled DB_* (encoded) or null', () => {
  assert.equal(pgUrlFrom({ X: 'postgres://explicit' }, { urlEnv: 'X' }), 'postgres://explicit');
  assert.equal(pgUrlFrom({}, { urlEnv: 'X', map: { DATABASE_URL: 'postgres://dbu' } }), 'postgres://dbu');
  assert.equal(
    pgUrlFrom({}, { urlEnv: 'X', map: { DB_HOST: 'h', DB_USER: 'u@x', DB_PASSWORD: 'p/w', DB_NAME: 'n', DB_SSLMODE: 'require' } }),
    'postgres://u%40x:p%2Fw@h:5432/n?sslmode=require',
  );
  assert.match(pgUrlFrom({}, { urlEnv: 'X', map: { DB_HOST: 'h' } }), /sslmode=disable$/);
  assert.equal(pgUrlFrom({}, { urlEnv: 'X', map: {} }), null);
  assert.equal(pgUrlFrom({ X: '' }, { urlEnv: 'X', map: { DATABASE_URL: 'postgres://dbu' } }), 'postgres://dbu', 'an empty variable is ignored');
});

test('pageNames lists each page once', () => {
  assert.deepEqual(pageNames(baseCfg()), ['home']);
});

test('openMonitors skips unreachable monitors with a message; takeSample still works', async () => {
  const messages = [];
  const cfg = baseCfg({ monitor: { postgres: { enabled: true }, redis: { enabled: true }, prometheus: { url: 'https://p.example.com' } } });
  const mon = await openMonitors(mkdtempSync(path.join(tmpdir(), 'lt-')), cfg, {}, (m) => messages.push(m));
  assert.equal(mon.pg, null);
  assert.equal(mon.redis, null);
  assert.equal(messages.length, 2);
  assert.ok(mon.prom);
  const sample = await takeSample({ ...mon, prom: null });
  assert.ok(sample.gen.cores >= 1);
  await closeMonitors(mon);
});

function fakeK6({ exitAfterMs, code }) {
  const child = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); if (signal === 'SIGTERM') setTimeout(() => child.emit('exit', 0), 5); };
  if (exitAfterMs) setTimeout(() => child.emit('exit', code ?? 0), exitAfterMs);
  return child;
}

test('runTier writes the tier artefacts when k6 ends normally', async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), 'lt-run-'));
  const child = fakeK6({ exitAfterMs: 40 });
  const tier = { name: 't1', concurrent: 5, rampSec: 1, holdSec: 5 };
  const meta = await runTier({ cfg: baseCfg(), tier, runDir, mon: {}, deps: { spawnImpl: () => child }, log: () => {} });
  assert.equal(meta.aborted, false);
  for (const f of ['plan.json', 'k6config.json', 'meta.json', 'samples.jsonl']) assert.ok(existsSync(path.join(runDir, 't1', f)), f);
  writeFileSync(path.join(runDir, 't1', 'summary.json'), JSON.stringify({ metrics: { http_reqs: { values: { count: 7, rate: 1 } } } }));
  const tiers = loadRun(runDir, baseCfg({ tiers: [tier] }), { peaks, k6Digest });
  assert.equal(tiers.length, 1);
  assert.equal(tiers[0].digest.requests, 7);
  assert.ok(!readFileSync(path.join(runDir, 't1', 'k6config.json'), 'utf8').includes('LOADTEST_ADMIN'));
});

test('runTier stops k6 gracefully when a guard is crossed', async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), 'lt-run-'));
  const child = fakeK6({});
  const cfg = baseCfg({ limits: { generatorLoadRatio: -1 } });
  const meta = await runTier({ cfg, tier: { name: 'g', concurrent: 5, rampSec: 0, holdSec: 5 }, runDir, mon: {}, deps: { spawnImpl: () => child }, log: () => {} });
  assert.equal(meta.aborted, true);
  assert.match(meta.abortReason, /generator\/load_ratio/);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('runTier marks a k6 threshold abort (exit code 99)', async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), 'lt-run-'));
  const meta = await runTier({ cfg: baseCfg(), tier: { name: 'x', concurrent: 5, rampSec: 0, holdSec: 5 }, runDir, mon: {}, deps: { spawnImpl: () => fakeK6({ exitAfterMs: 30, code: 99 }) }, log: () => {} });
  assert.equal(meta.aborted, true);
  assert.match(meta.abortReason, /threshold/);
});
