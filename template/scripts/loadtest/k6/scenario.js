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
 * Transport encryption: the real front opens an ECDH session (`POST /crypt/session`) and sends `x-crypt-session` on its
 * API calls, so the back encrypts (and compresses) every non-exempt response. Without that header a series payload would
 * be answered in clear and the heaviest server-side work (ECDH, AES-GCM, deflate, one Redis lookup per request) would not
 * be measured. With `model.crypt.enabled`, each VU opens its own session (renewed before it expires) and sends the headers;
 * the answers are NOT decrypted (only the server's cost matters). The session route is rate-limited per identity: when it
 * refuses, the VU runs in clear for a while and the tier reports a coverage below 100 %.
 *
 * Environment: LOADTEST_CONFIG (run config JSON), LOADTEST_USERS (accounts JSON), LOADTEST_SUMMARY (output file),
 * LOADTEST_BYPASS_KEY (optional Cloudflare skip-rule secret).
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const CFG = JSON.parse(open(__ENV.LOADTEST_CONFIG));
const USERS = CFG.plan.registered > 0 ? JSON.parse(open(__ENV.LOADTEST_USERS)) : [];
const BYPASS = __ENV.LOADTEST_BYPASS_KEY || '';
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const pageTrends = {};
for (const kind of ['registered', 'anonymous']) {
  for (const page of CFG.journeys[kind] || []) pageTrends[page.name] = pageTrends[page.name] || new Trend(`page_ms_${slug(page.name)}`, true);
}
// Uncompressed P-256 public key, generated once; its private half was discarded (answers are never decrypted).
const CRYPT_CLIENT_PUBLIC_KEY = 'BPyQ0nkadRo65ySh2lq20r9elIELBrCKDgYThBcHaZQ47BLisi2xoLHw55ZSF3megCsLXwDAxSlV8KHPiWux9jM=';
const CRYPT = CFG.model.crypt || { enabled: false };
const cryptCovered = new Rate('crypt_covered');
const cryptRefused = new Counter('crypt_session_refused');
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

function toRequest(step, pageName, token, cryptId) {
  const target = step.target || 'api';
  const path = Array.isArray(step.path) ? step.path[Math.floor(Math.random() * step.path.length)] : step.path;
  const headers = Object.assign({}, CFG.headers.all, CFG.headers[target], step.headers);
  if (BYPASS) headers[CFG.bypassHeader] = BYPASS;
  if (token && step.auth !== false) headers.Authorization = `Bearer ${token}`;
  if (cryptId && target === 'api' && step.crypt !== false) {
    headers['x-crypt-session'] = cryptId;
    headers['x-crypt-accept-encoding'] = CRYPT.acceptEncoding || 'deflate';
  }
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

function runStep(step, pageName, token, cryptId) {
  if (Array.isArray(step)) {
    const responses = http.batch(step.map((s) => toRequest(s, pageName, token, cryptId)));
    responses.forEach(record);
    return;
  }
  const req = toRequest(step, pageName, token, cryptId);
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

let cryptSession = null; // per VU: { id, expiresAt }
let cryptRetryAt = 0;

/** Session id to send, opening or renewing it when needed; null when disabled or refused (the VU then runs in clear). */
function ensureCryptSession(token) {
  if (!CRYPT.enabled) return null;
  const now = Date.now();
  if (cryptSession && cryptSession.expiresAt - 30000 > now) return cryptSession.id;
  if (cryptRetryAt > now) return null;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (BYPASS) headers[CFG.bypassHeader] = BYPASS;
  const res = http.post(`${CFG.targets.api}/crypt/session`, JSON.stringify({ clientPublicKey: CRYPT_CLIENT_PUBLIC_KEY }), {
    headers,
    tags: { name: 'api:crypt/session', page: 'crypt' },
    // A refusal is an expected, counted outcome here (not an error of the tier).
    responseCallback: http.expectedStatuses(201, { min: 400, max: 499 }),
  });
  if (res.status !== 201) {
    cryptRefused.add(1);
    cryptRetryAt = now + 30000;
    return null;
  }
  const body = res.json();
  cryptSession = { id: body.sessionId, expiresAt: now + (body.ttlMs || 600000) };
  return cryptSession.id;
}

function session(kind, token) {
  const [thinkMin, thinkMax] = CFG.model.thinkSec;
  if (Math.random() < CFG.model.coldLoadRatio[kind]) coldLoad();
  const cryptId = ensureCryptSession(token);
  if (CRYPT.enabled) cryptCovered.add(cryptId !== null);
  const page = pickPage(CFG.journeys[kind]);
  const started = Date.now();
  for (const step of page.requests) runStep(step, page.name, token, cryptId);
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
