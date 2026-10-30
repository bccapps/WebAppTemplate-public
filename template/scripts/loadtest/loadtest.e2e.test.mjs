/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * End to end: the real CLI drives the real k6 against a local mock server (never a remote target), then the report is
 * built. Skipped when the k6 binary is not installed.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HAS_K6 = spawnSync('k6', ['version']).status === 0;

function mockServer(seen) {
  return http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, bypass: req.headers['x-loadtest-key'] });
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end('<script src="/assets/app.js"></script>'); }
    if (req.url.startsWith('/api/v1/private') && !String(req.headers.authorization).startsWith('Bearer tok-')) { res.statusCode = 401; return res.end('{}'); }
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
}

const page = (name, requests) => ({ name, weight: 1, requests });

function writeProject(root, port) {
  mkdirSync(path.join(root, '.loadtest'), { recursive: true });
  writeFileSync(path.join(root, '.loadtest', 'users.json'), JSON.stringify([{ id: 1, token: 'tok-1' }, { id: 2, token: 'tok-2' }]));
  writeFileSync(path.join(root, 'loadtest.config.json'), JSON.stringify({
    targets: { front: `http://127.0.0.1:${port}`, api: `http://127.0.0.1:${port}/api/v1` },
    auth: { userCount: 2 },
    model: { thinkSec: [0.2, 0.4], coldLoadRatio: { registered: 0, anonymous: 1 } },
    tiers: [{ name: 'e2e', concurrent: 6, rampSec: 1, holdSec: 5, rampDownSec: 1 }],
    limits: { generatorLoadRatio: 1000, throttlePerMinute: 100000 },
    journeys: {
      registered: [page('private', [[{ path: '/private/a' }, { path: '/private/b' }]])],
      anonymous: [page('public', [{ path: '/public' }])],
    },
    monitor: { sampleSec: 1, cooldownSec: 0 },
  }));
}

test('CLI + k6 + report against a local mock server', { skip: !HAS_K6 && 'k6 not installed', timeout: 120000 }, async () => {
  const seen = [];
  const server = mockServer(seen);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = mkdtempSync(path.join(tmpdir(), 'lt-e2e-'));
  writeProject(root, server.address().port);
  const child = spawn('node', [path.join(HERE, 'loadtest.mjs'), 'run', '--tier', 'e2e', '--root', root], { stdio: 'pipe', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const [code] = await once(child, 'exit');
  server.close();
  assert.equal(code, 0, output.slice(-2000));

  const runs = path.join(root, '.loadtest', 'runs');
  const [runId] = readdirSync(runs);
  const tierDir = path.join(runs, runId, 'e2e');
  for (const f of ['plan.json', 'summary.json', 'samples.jsonl', 'meta.json']) assert.ok(existsSync(path.join(tierDir, f)), f);
  assert.equal(JSON.parse(readFileSync(path.join(tierDir, 'meta.json'), 'utf8')).aborted, false);

  const report = readFileSync(path.join(runs, runId, 'report.md'), 'utf8');
  if (process.env.LOADTEST_E2E_PRINT) console.log(report);
  assert.match(report, /\| e2e \| 6 \|/);
  assert.match(report, /\| OK \|/);
  assert.match(report, /## Page latency \(p95\)\n\n\| Page \(p95 ms\) \| e2e \|\n\|---\|---\|\n\| (private|public) /, 'page timings are in the report');
  assert.ok(seen.filter((r) => r.url.startsWith('/api/v1/private')).every((r) => /^Bearer tok-[12]$/.test(r.auth)), 'registered calls carry an account token');
  assert.ok(seen.filter((r) => r.url === '/api/v1/public').every((r) => r.auth === undefined), 'anonymous calls carry no token');
  assert.ok(seen.some((r) => r.url === '/assets/app.js'), 'cold load fetched the assets');
});
