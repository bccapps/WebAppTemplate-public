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
import { isProbeFailure, journeySteps, probeJourneys } from './probe.mjs';

const cfg = mergeConfig({
  targets: { api: 'https://a.io/api', front: 'https://a.io' },
  journeys: {
    registered: [{ name: 'home', weight: 1, requests: [[{ path: '/a' }, { path: ['/b', '/c'] }], { path: '/post', method: 'POST' }, { path: '/pub', auth: false }] }],
    anonymous: [{ name: 'land', weight: 1, requests: [{ path: '/x', target: 'front' }] }],
  },
});

test('journeySteps flattens batches', () => {
  assert.deepEqual(journeySteps(cfg, 'registered').map((s) => s.step.path), ['/a', ['/b', '/c'], '/post', '/pub']);
  assert.deepEqual(journeySteps(cfg, 'none'), []);
});

test('probeJourneys sends one GET per URL (every alternative of a path array), with the token only where allowed, and skips non-GET', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, auth: init.headers.Authorization }); return { status: url.endsWith('/c') ? 200 : url.endsWith('/b') ? 404 : 200 }; };
  const rows = await probeJourneys(cfg, { kind: 'registered', token: 'T', fetchImpl });
  assert.deepEqual(rows.map((r) => r.status), [200, 404, 200, 'skipped (not GET)', 200]);
  assert.equal(seen[0].auth, 'Bearer T');
  assert.equal(seen.at(-1).auth, undefined);
  assert.equal(seen[1].url, 'https://a.io/api/b');
  const anon = await probeJourneys(cfg, { kind: 'anonymous', token: null, fetchImpl });
  assert.equal(anon[0].url, 'https://a.io/x');
});

test('probeJourneys reports network errors; isProbeFailure classifies rows', async () => {
  const rows = await probeJourneys(cfg, { kind: 'anonymous', token: null, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.match(rows[0].status, /^error: ECONNRESET/);
  assert.equal(isProbeFailure(rows[0]), true);
  assert.equal(isProbeFailure({ status: 404 }), true);
  assert.equal(isProbeFailure({ status: 200 }), false);
  assert.equal(isProbeFailure({ status: 'skipped (not GET)' }), false);
});

test('probeJourneys sends the Cloudflare bypass header when given (so the probe crosses the WAF like the test will)', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers['x-loadtest-key']); return { status: 200 }; };
  await probeJourneys(cfg, { kind: 'anonymous', token: null, bypass: { header: 'x-loadtest-key', key: 'k' }, fetchImpl });
  await probeJourneys(cfg, { kind: 'anonymous', token: null, fetchImpl });
  assert.deepEqual(seen, ['k', undefined]);
});
