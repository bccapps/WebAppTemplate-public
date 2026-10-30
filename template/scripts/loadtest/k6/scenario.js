/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * k6 scenario driven entirely by the run config produced by `loadtest.mjs run` (never edit per project).
 * Closed model: every VU loops "pick a page, issue its requests, think". Registered VUs authenticate with the
 * static API token of one synthetic account; anonymous VUs send no credentials.
 *
 * Environment: LOADTEST_CONFIG (run config JSON), LOADTEST_USERS (accounts JSON), LOADTEST_SUMMARY (output file),
 * LOADTEST_BYPASS_KEY (optional Cloudflare skip-rule secret).
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const CFG = JSON.parse(open(__ENV.LOADTEST_CONFIG));
const USERS = CFG.plan.registered > 0 ? JSON.parse(open(__ENV.LOADTEST_USERS)) : [];
const BYPASS = __ENV.LOADTEST_BYPASS_KEY || '';
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const pageTrends = {};
for (const kind of ['registered', 'anonymous']) {
  for (const page of CFG.journeys[kind] || []) pageTrends[page.name] = pageTrends[page.name] || new Trend(`page_ms_${slug(page.name)}`, true);
}
const status429 = new Counter('status_429');
const status5xx = new Counter('status_5xx');
const status4xx = new Counter('status_4xx');

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }));

function scenarioFor(kind) {
  const stages = CFG.plan.stages[kind];
  if (!stages.length) return null;
  return { executor: 'ramping-vus', exec: kind, startVUs: 0, stages, gracefulRampDown: '15s', gracefulStop: '30s' };
}

const scenarios = {};
for (const kind of ['registered', 'anonymous']) {
  const scenario = scenarioFor(kind);
  if (scenario) scenarios[kind] = scenario;
}

export const options = {
  scenarios,
  userAgent: 'vx-loadtest/1',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    http_req_failed: [{ threshold: `rate<${CFG.limits.maxErrorRate}`, abortOnFail: true, delayAbortEval: '45s' }],
    http_req_duration: [{ threshold: `p(95)<${CFG.limits.maxP95Ms}`, abortOnFail: true, delayAbortEval: '60s' }],
  },
};

function pickPage(pages) {
  const total = pages.reduce((sum, page) => sum + page.weight, 0);
  let roll = Math.random() * total;
  for (const page of pages) { roll -= page.weight; if (roll <= 0) return page; }
  return pages[pages.length - 1];
}

function toRequest(step, pageName, token) {
  const target = step.target || 'api';
  const path = Array.isArray(step.path) ? step.path[Math.floor(Math.random() * step.path.length)] : step.path;
  const headers = Object.assign({}, CFG.headers.all, CFG.headers[target], step.headers);
  if (BYPASS) headers[CFG.bypassHeader] = BYPASS;
  if (token && step.auth !== false) headers.Authorization = `Bearer ${token}`;
  if (step.body) headers['Content-Type'] = 'application/json';
  return {
    method: step.method || 'GET',
    url: CFG.targets[target] + path,
    body: step.body ? JSON.stringify(step.body) : null,
    params: { headers, tags: { name: step.name || `${target}:${String(step.path).slice(0, 60)}`, page: pageName } },
  };
}

function record(response) {
  if (response.status === 429) status429.add(1);
  else if (response.status >= 500) status5xx.add(1);
  else if (response.status >= 400) status4xx.add(1);
}

function runStep(step, pageName, token) {
  if (Array.isArray(step)) {
    const responses = http.batch(step.map((s) => toRequest(s, pageName, token)));
    responses.forEach(record);
    return;
  }
  const req = toRequest(step, pageName, token);
  record(http.request(req.method, req.url, req.body, req.params));
}

/** First visit of a session: the SPA shell and its hashed assets (a cached visit skips this). */
function coldLoad() {
  const front = CFG.targets.front;
  if (!front) return;
  const index = http.get(`${front}/`, { tags: { name: 'front:index', page: 'static' } });
  record(index);
  const assets = [];
  const pattern = /(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g;
  let match;
  while ((match = pattern.exec(String(index.body))) !== null) assets.push(match[1]);
  if (assets.length) {
    http.batch(assets.map((a) => ['GET', front + a, null, { tags: { name: 'front:asset', page: 'static' } }])).forEach(record);
  }
}

function session(kind, token) {
  const [thinkMin, thinkMax] = CFG.model.thinkSec;
  if (Math.random() < CFG.model.coldLoadRatio[kind]) coldLoad();
  const page = pickPage(CFG.journeys[kind]);
  const started = Date.now();
  for (const step of page.requests) runStep(step, page.name, token);
  pageTrends[page.name].add(Date.now() - started);
  sleep(thinkMin + Math.random() * (thinkMax - thinkMin));
}

export function registered() {
  const user = USERS[exec.vu.idInTest % USERS.length];
  session('registered', user.token);
}

export function anonymous() {
  session('anonymous', null);
}

export function handleSummary(data) {
  return { [__ENV.LOADTEST_SUMMARY]: JSON.stringify(data) };
}
