/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Load model: turns a tier (simultaneous sessions) into virtual users and k6 stages, then estimates the traffic
 * it generates (requests/s, Redis operations) and flags what would distort the measurement. Pure functions.
 */

export const RAMP_DOWN_SEC = 20;

/** Splits `concurrent` sessions between registered and anonymous visitors following `mix`. */
export function splitConcurrent(concurrent, mix) {
  const registered = Math.round(concurrent * mix.registered);
  return { registered, anonymous: concurrent - registered };
}

/** How many VUs share one test account (1 = every VU has its own account, hence its own throttle bucket). */
export const accountReuse = (registeredVus, userCount) => (registeredVus === 0 ? 0 : Math.ceil(registeredVus / userCount));

/** k6 `ramping-vus` stages: ramp up, hold, ramp down. No stage at all for a zero target. */
export function buildStages(target, { rampSec, holdSec, rampDownSec = RAMP_DOWN_SEC }) {
  if (target <= 0) return [];
  const stages = [];
  if (rampSec > 0) stages.push({ duration: `${rampSec}s`, target });
  stages.push({ duration: `${holdSec}s`, target });
  stages.push({ duration: `${rampDownSec}s`, target: 0 });
  return stages;
}

export function planTier(cfg, tier) {
  const { registered, anonymous } = splitConcurrent(tier.concurrent, cfg.model.mix);
  return {
    name: tier.name,
    concurrent: tier.concurrent,
    registered,
    anonymous,
    accountReuse: accountReuse(registered, cfg.auth.userCount),
    stages: { registered: buildStages(registered, tier), anonymous: buildStages(anonymous, tier) },
    rampDownSec: tier.rampDownSec ?? RAMP_DOWN_SEC,
    durationSec: tier.rampSec + tier.holdSec + (tier.rampDownSec ?? RAMP_DOWN_SEC),
  };
}

/** Weighted mean of a per-page value. */
export function weightedMean(pages, valueOf) {
  const total = pages.reduce((sum, page) => sum + page.weight, 0);
  return pages.reduce((sum, page) => sum + page.weight * valueOf(page), 0) / total;
}

/** Number of HTTP requests a step list issues (a nested array is one parallel batch of n requests). */
export const requestCount = (page) => page.requests.reduce((n, step) => n + (Array.isArray(step) ? step.length : 1), 0);

/** Requests per page view for a journey, split by target (`api`, `front`, ...). The cold-load asset burst is not counted. */
export function requestsPerPage(pages) {
  return weightedMean(pages, requestCount);
}

/**
 * Expected traffic of a planned tier at steady state. Closed model: one VU does one page view every
 * `think + page time` seconds. Every request to the back costs `redisOpsPerRequest` Redis operations
 * (rate-limiter counter + token revocation check for authenticated requests).
 */
export function estimateTier(cfg, plan) {
  const cycleSec = (cfg.model.thinkSec[0] + cfg.model.thinkSec[1]) / 2 + cfg.model.avgPageSec;
  const regRps = cfg.journeys?.registered ? (plan.registered / cycleSec) * requestsPerPage(cfg.journeys.registered) : 0;
  const anonRps = cfg.journeys?.anonymous ? (plan.anonymous / cycleSec) * requestsPerPage(cfg.journeys.anonymous) : 0;
  const ops = cfg.model.redisOpsPerRequest;
  const redisOpsPerSec = regRps * ops.registered + anonRps * ops.anonymous;
  const steadyShare = Math.max(plan.durationSec - (plan.rampDownSec ?? RAMP_DOWN_SEC), 0) / plan.durationSec;
  return {
    cycleSec,
    registeredRps: regRps,
    anonymousRps: anonRps,
    totalRps: regRps + anonRps,
    redisOpsPerSec,
    redisOpsTotal: Math.round(redisOpsPerSec * plan.durationSec * steadyShare * 0.9),
    requestsTotal: Math.round((regRps + anonRps) * plan.durationSec * steadyShare * 0.9),
    perAccountPerMin: plan.registered ? (regRps * 60 * Math.max(plan.accountReuse, 1)) / plan.registered : 0,
    anonymousPerMinPerIp: (anonRps * 60) / Math.max(cfg.model.generatorIps, 1),
  };
}

/** What would make the numbers of this tier misleading, in plain words. */
export function planWarnings(cfg, plan, estimate) {
  const warnings = [];
  const limit = cfg.limits.throttlePerMinute;
  if (plan.accountReuse > 1) {
    warnings.push(`${plan.registered} registered VUs share ${cfg.auth.userCount} accounts (x${plan.accountReuse}): ${estimate.perAccountPerMin.toFixed(0)} req/min per account instead of a realistic per-user rate.`);
  }
  if (estimate.perAccountPerMin > limit * 0.5) {
    warnings.push(`Per-account rate (${estimate.perAccountPerMin.toFixed(0)}/min) exceeds half of the rate limiter (${limit}/min): 429 will appear and measure the limiter, not the capacity.`);
  }
  if (estimate.anonymousPerMinPerIp > limit) {
    warnings.push(`Anonymous traffic is ${estimate.anonymousPerMinPerIp.toFixed(0)} req/min per generator IP, above the limiter (${limit}/min): run 'throttle raise' for this tier (temporary, restored afterwards) or add generator IPs (model.generatorIps).`);
  }
  return warnings;
}
