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

import { basicAuthHeader, instantQuery, intervalFromSamples, sampleQueries, scrapeInterval, seriesKey, summarizeVector } from './prometheus.mjs';

const vector = [
  { metric: { instance: 'back1' }, value: [0, '42.5'] },
  { metric: { instance: 'back2' }, value: [0, '67'] },
  { metric: { instance: 'bad' }, value: [0, 'NaN'] },
];
const okFetch = (result) => async () => ({ ok: true, json: async () => ({ status: 'success', data: { result } }) });

test('basicAuthHeader', () => {
  assert.deepEqual(basicAuthHeader('u', 'p'), { Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` });
  assert.deepEqual(basicAuthHeader(undefined, 'p'), {});
});

test('seriesKey prefers instance then job', () => {
  assert.equal(seriesKey({ instance: 'i', job: 'j' }), 'i');
  assert.equal(seriesKey({ job: 'j' }), 'j');
  assert.equal(seriesKey({ x: 'y' }), 'y');
});

test('summarizeVector keeps the worst series and drops NaN', () => {
  assert.deepEqual(summarizeVector(vector), { max: 67, byInstance: { back1: 42.5, back2: 67 } });
  assert.equal(summarizeVector([]), null);
  assert.equal(summarizeVector(undefined), null);
});

test('instantQuery calls the API and summarizes', async () => {
  let called;
  const fetchImpl = async (url, init) => { called = { url, init }; return okFetch(vector)(); };
  const out = await instantQuery({ url: 'https://p.example.com/' }, 'up', { fetchImpl, headers: { A: 'b' } });
  assert.equal(out.max, 67);
  assert.match(called.url, /^https:\/\/p\.example\.com\/api\/v1\/query\?query=up$/);
  assert.equal(called.init.headers.A, 'b');
});

test('instantQuery throws on HTTP and Prometheus errors', async () => {
  await assert.rejects(instantQuery({ url: 'https://p' }, 'q', { fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
  await assert.rejects(instantQuery({ url: 'https://p' }, 'q', { fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'error', error: 'bad' }) }) }), /bad/);
});

test('sampleQueries isolates failures', async () => {
  const fetchImpl = async (url) => (url.includes('boom') ? { ok: false, status: 500 } : okFetch(vector)());
  const out = await sampleQueries({ url: 'https://p', queries: [{ name: 'a', query: 'ok' }, { name: 'b', query: 'boom' }] }, { fetchImpl });
  assert.equal(out.a.max, 67);
  assert.equal(out.b, null);
});

test('intervalFromSamples', () => {
  assert.equal(intervalFromSamples(5), 60);
  assert.equal(intervalFromSamples(30), 10);
  assert.equal(intervalFromSamples(0), null);
  assert.equal(intervalFromSamples(undefined), null);
});

test('scrapeInterval queries the slowest target of a job and rejects odd job names', async () => {
  let url;
  const fetchImpl = async (u) => { url = u; return okFetch([{ metric: {}, value: [0, '5'] }])(); };
  assert.equal(await scrapeInterval({ url: 'https://p' }, 'exporter', { fetchImpl }), 60);
  assert.ok(decodeURIComponent(url).includes('min(count_over_time(up{job="exporter"}[5m]))'));
  await assert.rejects(scrapeInterval({ url: 'https://p' }, 'x"}) or vector(1', { fetchImpl }), /invalid Prometheus job name/);
});
