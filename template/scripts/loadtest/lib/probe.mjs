/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Validates the journeys of a config with ONE request per step (GET only): wrong paths and gated pages show up
 * here, as a table, instead of as an unreadable wall of 4xx in the middle of a load test.
 */

const flatten = (requests) => requests.flatMap((step) => (Array.isArray(step) ? step : [step]));
const allPaths = (path) => (Array.isArray(path) ? path : [path]);

/** Every step of a journey kind as `{ kind, page, step }`. */
export function journeySteps(cfg, kind) {
  return (cfg.journeys?.[kind] ?? []).flatMap((page) => flatten(page.requests).map((step) => ({ kind, page: page.name, step })));
}

/** Probes every distinct URL of every step (all alternatives of a `path` array), one GET each. */
export async function probeJourneys(cfg, { kind, token, bypass = null, fetchImpl = fetch }) {
  const rows = [];
  for (const { page, step } of journeySteps(cfg, kind)) {
    const target = step.target || 'api';
    for (const path of allPaths(step.path)) rows.push(await probeOne(cfg, { kind, page, step, target, url: cfg.targets[target] + path, token, bypass, fetchImpl }));
  }
  return rows;
}

async function probeOne(cfg, { kind, page, step, target, url, token, bypass, fetchImpl }) {
  if ((step.method || 'GET') !== 'GET') return { kind, page, url, status: 'skipped (not GET)', ms: null };
  const headers = { ...cfg.headers.all, ...cfg.headers[target], ...step.headers, ...(token && step.auth !== false ? { Authorization: `Bearer ${token}` } : {}), ...(bypass ? { [bypass.header]: bypass.key } : {}) };
  const started = Date.now();
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
    return { kind, page, url, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { kind, page, url, status: `error: ${error.message}`, ms: null };
  }
}

export const isProbeFailure = (row) => typeof row.status === 'number' ? row.status >= 400 : row.status.startsWith('error');
