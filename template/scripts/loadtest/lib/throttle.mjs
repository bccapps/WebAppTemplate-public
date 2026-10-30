/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Temporary raise of the back's global rate limiter (`common_throttleDefaultLimit`) for the anonymous tiers: the
 * generator is a single IP, so its anonymous sessions would otherwise be answered 429 and measure the limiter instead
 * of the capacity. The previous value is persisted by the caller so `restore` works even after a crash. The limit is
 * read at every request by the back: no restart involved.
 */

import { estimateTier, planTier } from './profile.mjs';

export const THROTTLE_DEFAULTS = { moduleId: 'common', key: 'common_throttleDefaultLimit', safetyFactor: 1.5 };

const roundUp = (value, step) => Math.ceil(value / step) * step;

/**
 * Limit needed so that no identity of the listed tiers is limited: the busiest of the anonymous per-IP rate and the
 * per-account rate, with a safety factor, never below the configured production limit.
 */
export function neededLimit(cfg, tiers) {
  const factor = cfg.throttle?.safetyFactor ?? THROTTLE_DEFAULTS.safetyFactor;
  let busiest = 0;
  for (const tier of tiers) {
    const plan = planTier(cfg, tier);
    const est = estimateTier(cfg, plan);
    busiest = Math.max(busiest, est.anonymousPerMinPerIp, est.perAccountPerMin);
  }
  return Math.max(cfg.limits.throttlePerMinute, roundUp(busiest * factor, 100));
}

/** True when the listed tiers would hit the production limit without a raise. */
export const needsRaise = (cfg, tiers) => neededLimit(cfg, tiers) > cfg.limits.throttlePerMinute;

const settings = (cfg) => ({ ...THROTTLE_DEFAULTS, ...cfg.throttle });

export async function readLimit(client, cfg) {
  const { moduleId, key } = settings(cfg);
  const config = await client.request('GET', `/admin/module-configs/${moduleId}`);
  const value = config?.currentValues?.[key];
  if (!Number.isFinite(Number(value))) throw new Error(`cannot read ${key} from module "${moduleId}"`);
  return Number(value);
}

export async function writeLimit(client, cfg, value) {
  const { moduleId, key } = settings(cfg);
  await client.request('PUT', `/admin/module-configs/${moduleId}`, { [key]: value });
}

/**
 * Raises the limit to `target`. Returns the state to persist: `{ key, previous, raisedTo }`. When a state already
 * exists (`existing`), its `previous` is kept so a second raise never overwrites the real original value.
 */
export async function raiseLimit(client, cfg, target, existing = null) {
  const { key } = settings(cfg);
  const previous = existing?.previous ?? (await readLimit(client, cfg));
  await writeLimit(client, cfg, target);
  return { key, previous, raisedTo: target, at: new Date().toISOString() };
}

/** Puts the original value back. Returns it. */
export async function restoreLimit(client, cfg, state) {
  await writeLimit(client, cfg, state.previous);
  return state.previous;
}
