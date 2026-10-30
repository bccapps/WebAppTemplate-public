/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeConfig } from './config.mjs';
import { extrapolate, k6Digest, linearFit, peaks, renderReport, verdict } from './report.mjs';

const summary = {
  metrics: {
    http_reqs: { values: { count: 1000, rate: 10 } },
    http_req_failed: { values: { rate: 0.01 } },
    http_req_duration: { values: { med: 80, 'p(90)': 200, 'p(95)': 300, 'p(99)': 900, max: 2000 } },
    status_429: { values: { count: 0 } },
    status_5xx: { values: { count: 2 } },
    data_received: { values: { count: 2097152 } },
    page_ms_home: { values: { avg: 400, 'p(95)': 700 } },
  },
};

test('k6Digest extracts the headline numbers and page timings', () => {
  const digest = k6Digest(summary, ['home', 'missing']);
  assert.equal(digest.requests, 1000);
  assert.equal(digest.p95, 300);
  assert.equal(digest.receivedMb, 2);
  assert.deepEqual(Object.keys(digest.pages), ['home']);
  assert.equal(digest.pages.home.p95, 700);
  assert.equal(k6Digest(null).requests, 0);
});

test('peaks keeps the highest value and the worst instance', () => {
  const out = peaks([
    { prom: { cpu: { max: 30, byInstance: { a: 30 } } }, pg: { connections: 5 }, redis: { opsPerSec: 10 }, gen: { loadRatio: 0.1 } },
    { prom: { cpu: { max: 70, byInstance: { a: 20, b: 70 } }, none: null }, pg: { connections: 9 }, redis: { opsPerSec: 4 }, gen: { loadRatio: 0.3 } },
  ]);
  assert.deepEqual(out.prom.cpu, { max: 70, worst: 'b' });
  assert.equal(out.pg.connections, 9);
  assert.equal(out.redis.opsPerSec, 10);
  assert.equal(out.gen.loadRatio, 0.3);
});

test('verdict lists every reason', () => {
  const limits = { maxErrorRate: 0.05, maxP95Ms: 250 };
  const digest = k6Digest(summary);
  const bad = verdict({ ...digest, status429: 3 }, { aborted: true, abortReason: 'cpu' }, limits);
  assert.equal(bad.ok, false);
  assert.equal(bad.reasons.length, 3);
  assert.equal(verdict({ ...digest, p95: 100, errorRate: 0.01, status429: 0 }, { aborted: false }, limits).ok, true);
});

test('linearFit and extrapolate', () => {
  const fit = linearFit([[0, 1], [10, 11], [20, 21]]);
  assert.ok(Math.abs(fit.slope - 1) < 1e-9 && Math.abs(fit.intercept - 1) < 1e-9);
  assert.equal(extrapolate([[50, 10], [100, 20], [200, 40]], 80), 400);
  assert.equal(extrapolate([[50, 10], [100, 20]], 80), null);
  assert.equal(extrapolate([[50, 10], [100, 10], [200, 10]], 80), null);
  assert.equal(linearFit([[1, 1]]), null);
});

test('renderReport produces every section', () => {
  const cfg = mergeConfig({ targets: { api: 'https://a.io/api', front: 'https://a.io' }, monitor: { prometheus: { url: 'x', queries: [{ name: 'cpu', query: 'q', unit: '%', guard: { max: 85 } }] } } });
  const tiers = [50, 100, 200].map((n) => ({
    plan: { name: `u${n}`, concurrent: n },
    estimate: { redisOpsTotal: 1000 },
    digest: k6Digest({ metrics: { ...summary.metrics, http_req_duration: { values: { med: 50, 'p(90)': 90, 'p(95)': n, 'p(99)': 2 * n, max: 3 * n } } } }, ['home']),
    peaks: { prom: { cpu: { max: n / 4, worst: 'back1' } }, pg: {}, redis: {}, gen: {} },
    meta: { aborted: false, redisCommandsDelta: 1234, statements: [{ query: 'SELECT 1 | x', calls: 5, totalMs: 10, meanMs: 2 }] },
  }));
  const md = renderReport({ cfg, runId: 'r1', tiers });
  for (const heading of ['# Load test report — r1', '## Results per tier', '## Peak resource usage', '## Page latency (p95)', '## Quota consumption', '## Heaviest SQL', '## Extrapolation']) {
    assert.ok(md.includes(heading), heading);
  }
  assert.ok(md.includes('back1') && md.includes('1234') && md.includes('SELECT 1 \\| x'));
  assert.match(md, /simultaneous sessions/);
});
