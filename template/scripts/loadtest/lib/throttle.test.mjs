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
import { neededLimit, needsRaise, raiseLimit, readLimit, restoreLimit, writeLimit } from './throttle.mjs';

const page = { name: 'p', weight: 1, requests: [{ path: '/x' }] };
const cfg = mergeConfig({ targets: { api: 'https://a.io/api' }, journeys: { registered: [page], anonymous: [page] }, model: { thinkSec: [1, 1], avgPageSec: 0 } });
const tier = (name, concurrent) => ({ name, concurrent, rampSec: 0, holdSec: 60 });

function fakeAdmin(initial = 300) {
  const calls = [];
  let value = initial;
  return {
    calls,
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'PUT') { value = body.common_throttleDefaultLimit; return {}; }
      return { currentValues: { common_throttleDefaultLimit: value } };
    },
  };
}

test('neededLimit never goes below the production limit and scales with the busiest identity', () => {
  assert.equal(neededLimit(cfg, [tier('tiny', 2)]), 300);
  const big = neededLimit(cfg, [tier('big', 200)]);
  assert.ok(big > 300 && big % 100 === 0);
  assert.ok(neededLimit(cfg, [tier('bigger', 400)]) > big);
  assert.equal(neededLimit(cfg, [tier('tiny', 2), tier('big', 200)]), big);
});

test('needsRaise', () => {
  assert.equal(needsRaise(cfg, [tier('tiny', 2)]), false);
  assert.equal(needsRaise(cfg, [tier('big', 200)]), true);
});

test('readLimit / writeLimit use the module-config contract', async () => {
  const admin = fakeAdmin(300);
  assert.equal(await readLimit(admin, cfg), 300);
  await writeLimit(admin, cfg, 5000);
  assert.deepEqual(admin.calls.at(-1), { method: 'PUT', path: '/admin/module-configs/common', body: { common_throttleDefaultLimit: 5000 } });
  await assert.rejects(readLimit({ request: async () => ({}) }, cfg), /cannot read/);
});

test('raiseLimit keeps the ORIGINAL previous value across two raises; restoreLimit puts it back', async () => {
  const admin = fakeAdmin(300);
  const first = await raiseLimit(admin, cfg, 2000);
  assert.deepEqual({ previous: first.previous, raisedTo: first.raisedTo }, { previous: 300, raisedTo: 2000 });
  const second = await raiseLimit(admin, cfg, 9000, first);
  assert.equal(second.previous, 300);
  assert.equal(await readLimit(admin, cfg), 9000);
  assert.equal(await restoreLimit(admin, cfg, second), 300);
  assert.equal(await readLimit(admin, cfg), 300);
});
