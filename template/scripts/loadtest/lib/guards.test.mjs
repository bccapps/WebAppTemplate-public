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
import { checkGuards, describeBreach } from './guards.mjs';

const cfg = mergeConfig({
  monitor: { prometheus: { url: 'x', queries: [{ name: 'cpu', query: 'q', guard: { max: 85 } }, { name: 'info', query: 'q' }] }, redis: { maxOpsPerSec: 1000 } },
});

test('a healthy sample crosses nothing', () => {
  const sample = { prom: { cpu: { max: 40, byInstance: { a: 40 } } }, pg: { connections: 10, maxConnections: 60 }, redis: { usedMemory: 10, maxMemory: 1000, opsPerSec: 5 }, gen: { loadRatio: 0.2 } };
  assert.deepEqual(checkGuards(sample, cfg), []);
});

test('each source reports its own breach', () => {
  const sample = {
    prom: { cpu: { max: 90, byInstance: { a: 50, b: 90 } }, info: { max: 1e9, byInstance: {} } },
    pg: { connections: 50, maxConnections: 60 },
    redis: { usedMemory: 800, maxMemory: 1000, opsPerSec: 2000 },
    gen: { loadRatio: 0.95 },
  };
  const breaches = checkGuards(sample, cfg);
  assert.deepEqual(breaches.map((b) => `${b.source}/${b.metric}`).sort(), ['generator/load_ratio', 'postgres/connections', 'prometheus/cpu', 'redis/ops_per_sec', 'redis/used_memory']);
  assert.equal(breaches.find((b) => b.source === 'prometheus').detail, 'b');
});

test('missing data is never a breach', () => {
  assert.deepEqual(checkGuards({ prom: { cpu: null }, pg: null, redis: null }, cfg), []);
});

test('describeBreach is readable', () => {
  assert.match(describeBreach({ source: 'postgres', metric: 'connections', value: 50, limit: 42, detail: 'max_connections=60' }), /postgres\/connections = 50.00 > 42.00 \(max_connections=60\)/);
});
