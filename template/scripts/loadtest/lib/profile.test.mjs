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
import { RAMP_DOWN_SEC, accountReuse, buildStages, estimateTier, planTier, planWarnings, requestCount, requestsPerPage, splitConcurrent, weightedMean } from './profile.mjs';

const journeys = {
  registered: [
    { name: 'a', weight: 3, requests: [{ path: '/1' }, [{ path: '/2' }, { path: '/3' }]] },
    { name: 'b', weight: 1, requests: [{ path: '/4' }] },
  ],
  anonymous: [{ name: 'c', weight: 1, requests: [{ path: '/5' }] }],
};
const cfg = (over = {}) => mergeConfig({ targets: { api: 'https://a.io' }, journeys, ...over });

test('splitConcurrent keeps the total', () => {
  assert.deepEqual(splitConcurrent(500, { registered: 0.4, anonymous: 0.6 }), { registered: 200, anonymous: 300 });
  assert.deepEqual(splitConcurrent(5, { registered: 0.4, anonymous: 0.6 }), { registered: 2, anonymous: 3 });
});

test('accountReuse', () => {
  assert.equal(accountReuse(0, 100), 0);
  assert.equal(accountReuse(100, 100), 1);
  assert.equal(accountReuse(200, 100), 2);
});

test('buildStages: ramp, hold, ramp down; nothing for zero', () => {
  assert.deepEqual(buildStages(10, { rampSec: 30, holdSec: 60 }), [
    { duration: '30s', target: 10 }, { duration: '60s', target: 10 }, { duration: `${RAMP_DOWN_SEC}s`, target: 0 },
  ]);
  assert.equal(buildStages(10, { rampSec: 0, holdSec: 60 }).length, 2);
  assert.deepEqual(buildStages(0, { rampSec: 30, holdSec: 60 }), []);
});

test('weightedMean / requestCount / requestsPerPage count batches by their size', () => {
  assert.equal(requestCount(journeys.registered[0]), 3);
  assert.equal(weightedMean([{ weight: 1, v: 2 }, { weight: 3, v: 6 }], (p) => p.v), 5);
  assert.equal(requestsPerPage(journeys.registered), (3 * 3 + 1 * 1) / 4);
});

test('planTier builds the stages and duration', () => {
  const plan = planTier(cfg(), { name: 't', concurrent: 200, rampSec: 60, holdSec: 300 });
  assert.equal(plan.registered, 80);
  assert.equal(plan.anonymous, 120);
  assert.equal(plan.accountReuse, 1);
  assert.equal(plan.durationSec, 60 + 300 + RAMP_DOWN_SEC);
  assert.equal(plan.stages.registered.length, 3);
});

test('estimateTier: closed model and Redis operations', () => {
  const config = cfg({ model: { thinkSec: [4, 6], avgPageSec: 1 } });
  const plan = planTier(config, { name: 't', concurrent: 100, rampSec: 0, holdSec: 600 });
  const est = estimateTier(config, plan);
  assert.equal(est.cycleSec, 6);
  assert.ok(Math.abs(est.registeredRps - (40 / 6) * 2.5) < 1e-9);
  assert.ok(Math.abs(est.anonymousRps - 60 / 6) < 1e-9);
  assert.ok(Math.abs(est.redisOpsPerSec - (est.registeredRps * 2 + est.anonymousRps)) < 1e-9);
  assert.ok(est.redisOpsTotal > 0 && est.requestsTotal > 0);
});

test('planWarnings flags account sharing, per-account and per-IP limiter pressure', () => {
  const config = cfg({ auth: { userCount: 10 }, limits: { throttlePerMinute: 30 }, model: { thinkSec: [1, 1], avgPageSec: 0.1 } });
  const plan = planTier(config, { name: 't', concurrent: 100, rampSec: 0, holdSec: 60 });
  const text = planWarnings(config, plan, estimateTier(config, plan)).join('\n');
  assert.match(text, /share 10 accounts/);
  assert.match(text, /per-account|Per-account/);
  assert.match(text, /per generator IP/);
  const calm = cfg();
  const calmPlan = planTier(calm, { name: 't', concurrent: 5, rampSec: 0, holdSec: 60 });
  assert.deepEqual(planWarnings(calm, calmPlan, estimateTier(calm, calmPlan)), []);
});
