/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * `loadtest.config.json` (project root): defaults, merge and validation. Pure functions except `loadConfig`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'loadtest.config.json';

export const DEFAULTS = {
  headers: { all: { 'Accept-Encoding': 'gzip' } },
  auth: {
    adminTokenEnv: 'LOADTEST_ADMIN_TOKEN',
    userCount: 100,
    prefix: 'loadtest',
    tierId: null,
    userTable: 'user',
    nicknameColumn: 'nickname',
    paths: {
      create: '/users/admin/standard',
      token: '/users/admin/{id}/api-token',
      revoke: '/users/admin/revoke-jti',
      remove: '/users/admin/{id}',
    },
  },
  model: {
    mix: { registered: 0.4, anonymous: 0.6 },
    thinkSec: [3, 15],
    avgPageSec: 0.8,
    coldLoadRatio: { registered: 0.2, anonymous: 0.9 },
    redisOpsPerRequest: { registered: 2, anonymous: 1 },
    generatorIps: 1,
  },
  tiers: [
    { name: 'smoke', concurrent: 5, rampSec: 20, holdSec: 160 },
    { name: 'u50', concurrent: 50, rampSec: 60, holdSec: 540 },
    { name: 'u200', concurrent: 200, rampSec: 90, holdSec: 510 },
    { name: 'u500', concurrent: 500, rampSec: 120, holdSec: 480 },
    { name: 'u1000', concurrent: 1000, rampSec: 150, holdSec: 150, optional: true },
  ],
  limits: {
    maxErrorRate: 0.05,
    maxP95Ms: 5000,
    throttlePerMinute: 300,
    pgConnectionsRatio: 0.7,
    redisMemoryRatio: 0.7,
    generatorLoadRatio: 0.8,
  },
  monitor: {
    sampleSec: 10,
    cooldownSec: 60,
    prometheus: null,
    postgres: { enabled: false, urlEnv: 'LOADTEST_PG_URL', envFile: null, verifySsl: false },
    redis: { enabled: false, urlEnv: 'LOADTEST_REDIS_URL', envFile: null, maxOpsPerSec: null },
  },
  cloudflare: null,
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Deep merge: objects merge key by key, arrays and scalars of `over` replace those of `base`. */
export function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = deepMerge(base[key], value);
  return out;
}

export const mergeConfig = (user) => deepMerge(DEFAULTS, user ?? {});

const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\/[^/\s]+/.test(value);

function validateTiers(tiers, errors) {
  const seen = new Set();
  for (const tier of tiers) {
    if (!tier.name || seen.has(tier.name)) errors.push(`tiers: missing or duplicate name "${tier.name}"`);
    seen.add(tier.name);
    if (!(tier.concurrent > 0) || !(tier.holdSec > 0) || !(tier.rampSec >= 0)) {
      errors.push(`tiers.${tier.name}: concurrent > 0, holdSec > 0 and rampSec >= 0 are required`);
    }
  }
}

function validatePages(kind, pages, errors) {
  if (!Array.isArray(pages) || pages.length === 0) { errors.push(`journeys.${kind}: at least one page is required`); return; }
  for (const page of pages) {
    if (!page.name) errors.push(`journeys.${kind}: a page has no name`);
    if (!(page.weight > 0)) errors.push(`journeys.${kind}.${page.name}: weight must be > 0`);
    if (!Array.isArray(page.requests) || page.requests.length === 0) errors.push(`journeys.${kind}.${page.name}: requests is empty`);
  }
}

/** Returns the list of problems (empty = valid). */
export function validateConfig(cfg) {
  const errors = [];
  if (!isHttpUrl(cfg.targets?.api)) errors.push('targets.api must be an http(s) URL');
  if (cfg.targets?.front !== undefined && !isHttpUrl(cfg.targets.front)) errors.push('targets.front must be an http(s) URL');
  const { mix, thinkSec } = cfg.model;
  if (Math.abs(mix.registered + mix.anonymous - 1) > 0.001) errors.push('model.mix must sum to 1');
  if (!Array.isArray(thinkSec) || thinkSec.length !== 2 || thinkSec[0] > thinkSec[1]) errors.push('model.thinkSec must be [min, max]');
  if (!(cfg.auth.userCount >= 1)) errors.push('auth.userCount must be >= 1');
  validateTiers(cfg.tiers, errors);
  if (mix.registered > 0) validatePages('registered', cfg.journeys?.registered, errors);
  if (mix.anonymous > 0) validatePages('anonymous', cfg.journeys?.anonymous, errors);
  return errors;
}

/** Reads, merges and validates the project config. Throws one error listing every problem. */
export function loadConfig(root, file = CONFIG_FILE) {
  const full = path.resolve(root, file);
  if (!existsSync(full)) throw new Error(`${file} not found in ${root} (run: node scripts/loadtest/loadtest.mjs init)`);
  const cfg = mergeConfig(JSON.parse(readFileSync(full, 'utf8')));
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(`Invalid ${file}:\n - ${errors.join('\n - ')}`);
  return cfg;
}

export function findTier(cfg, name) {
  const tier = cfg.tiers.find((t) => t.name === name);
  if (!tier) throw new Error(`Unknown tier "${name}" (available: ${cfg.tiers.map((t) => t.name).join(', ')})`);
  return tier;
}
