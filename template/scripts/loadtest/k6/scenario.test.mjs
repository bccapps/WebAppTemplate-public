/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Runs scenario.js under Node with the `k6/*` modules replaced by recorders: checks page selection, headers,
 * parallel batches, status counters and the cold-load asset burst without needing the k6 binary.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const STUBS = {
  'k6/http': 'export default new Proxy({}, { get: (_, key) => globalThis.__k6.http[key] });',
  k6: 'export const sleep = (s) => globalThis.__k6.sleeps.push(s);',
  'k6/execution': 'export default new Proxy({}, { get: (_, key) => globalThis.__k6.exec[key] });',
  'k6/metrics': `
    export class Counter { constructor(name) { this.name = name; } add(v) { globalThis.__k6.counters[this.name] = (globalThis.__k6.counters[this.name] || 0) + v; } }
    export class Trend { constructor(name) { this.name = name; } add(v) { (globalThis.__k6.trends[this.name] ||= []).push(v); } }`,
};
const hook = `export async function resolve(specifier, context, next) {
  const stubs = ${JSON.stringify(STUBS)};
  if (stubs[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const page = (name, requests) => ({ name, weight: 1, requests });
const config = {
  targets: { api: 'https://api.test/api/v1', front: 'https://front.test' },
  headers: { all: { 'Accept-Encoding': 'gzip' }, api: { 'X-Api': '1' } },
  journeys: {
    registered: [page('home', [[{ path: '/a' }, { path: '/b' }], { path: '/c', auth: false }])],
    anonymous: [page('land', [{ path: ['/p1'], name: 'api:land' }])],
  },
  model: { thinkSec: [2, 2], coldLoadRatio: { registered: 0, anonymous: 1 } },
  limits: { maxErrorRate: 0.05, maxP95Ms: 5000 },
  plan: { registered: 2, anonymous: 3, stages: { registered: [{ duration: '10s', target: 2 }], anonymous: [] } },
  bypassHeader: 'x-loadtest-key',
};

function setup() {
  const calls = [];
  const state = { calls, counters: {}, trends: {}, sleeps: [], exec: { vu: { idInTest: 1 } } };
  state.http = {
    setResponseCallback() {}, expectedStatuses: () => null,
    request: (method, url, body, params) => { calls.push({ method, url, params }); return { status: url.endsWith('/c') ? 429 : 200, body: '' }; },
    get: (url) => { calls.push({ method: 'GET', url }); return { status: 200, body: '<script src="/assets/app.js"></script><link href="/assets/app.css">' }; },
    batch: (reqs) => { calls.push({ batch: reqs.map((r) => (Array.isArray(r) ? r[1] : r.url)), auth: reqs.map((r) => r.params?.headers?.Authorization) }); return reqs.map(() => ({ status: 503 })); },
  };
  globalThis.__k6 = state;
  globalThis.__ENV = { LOADTEST_CONFIG: '/cfg.json', LOADTEST_USERS: '/users.json', LOADTEST_SUMMARY: '/out.json', LOADTEST_BYPASS_KEY: 'secret' };
  globalThis.open = (file) => JSON.stringify(file === '/cfg.json' ? config : [{ token: 'tok-0' }, { token: 'tok-1' }]);
  return state;
}

test('scenario: options, registered session, anonymous cold load, counters', async () => {
  const state = setup();
  const scenario = await import(`${pathToFileURL(new URL('./scenario.js', import.meta.url).pathname)}?t=${Date.now()}`);

  assert.deepEqual(Object.keys(scenario.options.scenarios), ['registered']);
  assert.equal(scenario.options.scenarios.registered.exec, 'registered');
  assert.match(scenario.options.thresholds.http_req_failed[0].threshold, /rate<0.05/);
  assert.match(scenario.options.thresholds.http_req_duration[0].threshold, /p\(95\)<5000/);

  scenario.registered();
  const batch = state.calls.find((c) => c.batch);
  assert.deepEqual(batch.batch, ['https://api.test/api/v1/a', 'https://api.test/api/v1/b']);
  const single = state.calls.find((c) => c.url === 'https://api.test/api/v1/c');
  assert.equal(single.params.headers.Authorization, undefined, 'auth:false step sends no token');
  assert.equal(single.params.headers['X-Api'], '1');
  assert.equal(single.params.headers['x-loadtest-key'], 'secret');
  assert.equal(state.counters.status_429, 1);
  assert.equal(state.counters.status_5xx, 2);
  assert.equal(state.trends.page_ms_home.length, 1);
  assert.deepEqual(state.sleeps, [2]);

  state.calls.length = 0;
  scenario.anonymous();
  assert.equal(state.calls[0].url, 'https://front.test/', 'cold load starts with the SPA index');
  assert.deepEqual(state.calls[1].batch, ['https://front.test/assets/app.js', 'https://front.test/assets/app.css']);
  const api = state.calls.find((c) => c.url === 'https://api.test/api/v1/p1');
  assert.equal(api.params.headers.Authorization, undefined);
  assert.equal(api.params.tags.name, 'api:land');

  const summary = scenario.handleSummary({ metrics: {} });
  assert.deepEqual(Object.keys(summary), ['/out.json']);
});

test('scenario: a registered VU maps to its own account (modulo the account count)', async () => {
  const seen = [];
  for (const [index, idInTest] of [1, 2, 3].entries()) {
    const state = setup();
    state.exec.vu.idInTest = idInTest;
    const scenario = await import(`${pathToFileURL(new URL('./scenario.js', import.meta.url).pathname)}?t=${Date.now()}-${index}`);
    scenario.registered();
    seen.push(state.calls.find((c) => c.batch).auth[0]);
  }
  assert.deepEqual(seen, ['Bearer tok-1', 'Bearer tok-0', 'Bearer tok-1']);
});
