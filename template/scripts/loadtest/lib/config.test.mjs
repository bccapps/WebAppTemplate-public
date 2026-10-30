/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULTS, deepMerge, findTier, loadConfig, mergeConfig, validateConfig } from './config.mjs';

const page = { name: 'home', weight: 1, requests: [{ path: '/x' }] };
const valid = () => mergeConfig({ targets: { api: 'https://a.example.com/api/v1' }, journeys: { registered: [page], anonymous: [page] } });

test('deepMerge merges objects and replaces arrays/scalars', () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2], n: 1 }, { a: { c: 3 }, list: [9], n: undefined });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9], n: 1 });
});

test('mergeConfig keeps defaults the user does not set', () => {
  const cfg = mergeConfig({ limits: { maxP95Ms: 100 } });
  assert.equal(cfg.limits.maxP95Ms, 100);
  assert.equal(cfg.limits.maxErrorRate, DEFAULTS.limits.maxErrorRate);
});

test('validateConfig accepts a minimal valid config', () => {
  assert.deepEqual(validateConfig(valid()), []);
});

test('validateConfig reports every problem', () => {
  const cfg = mergeConfig({
    targets: { api: 'nope' },
    model: { mix: { registered: 0.5, anonymous: 0.2 }, thinkSec: [9, 3] },
    auth: { userCount: 0 },
    tiers: [{ name: 'a', concurrent: 0, holdSec: 1, rampSec: 0 }, { name: 'a', concurrent: 1, holdSec: 1, rampSec: 0 }],
    journeys: { registered: [{ name: 'p', weight: 0, requests: [] }] },
  });
  const errors = validateConfig(cfg).join('\n');
  for (const needle of ['targets.api', 'model.mix', 'thinkSec', 'userCount', 'duplicate', 'tiers.a', 'weight', 'requests is empty', 'journeys.anonymous']) {
    assert.ok(errors.includes(needle), `missing: ${needle}\n${errors}`);
  }
});

test('loadConfig reads, merges and validates; throws a helpful error otherwise', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lt-'));
  assert.throws(() => loadConfig(dir), /not found/);
  writeFileSync(path.join(dir, 'loadtest.config.json'), JSON.stringify({ targets: { api: 'x' } }));
  assert.throws(() => loadConfig(dir), /Invalid loadtest.config.json/);
  writeFileSync(path.join(dir, 'loadtest.config.json'), JSON.stringify({ targets: { api: 'https://a.io/api' }, journeys: { registered: [page], anonymous: [page] } }));
  assert.equal(loadConfig(dir).targets.api, 'https://a.io/api');
});

test('findTier returns a tier or lists the available ones', () => {
  assert.equal(findTier(valid(), 'u50').concurrent, 50);
  assert.throws(() => findTier(valid(), 'zzz'), /available: smoke/);
});
