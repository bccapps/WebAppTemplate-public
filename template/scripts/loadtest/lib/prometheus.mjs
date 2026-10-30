/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Minimal Prometheus HTTP API client (instant queries), used to sample host and application health during a run.
 */

export function basicAuthHeader(user, password) {
  return user ? { Authorization: `Basic ${Buffer.from(`${user}:${password ?? ''}`).toString('base64')}` } : {};
}

/** First label value that identifies the series (`instance`, else `job`, else the first label). */
export function seriesKey(metric) {
  return metric.instance ?? metric.job ?? Object.values(metric)[0] ?? 'series';
}

/**
 * `{ max, byInstance }` of an instant-query result: the worst series wins, NaN/Inf are dropped.
 * `null` when the query returned nothing usable.
 */
export function summarizeVector(result) {
  const byInstance = {};
  for (const item of result ?? []) {
    const value = Number(item.value?.[1]);
    if (!Number.isFinite(value)) continue;
    const key = [...new Set([seriesKey(item.metric ?? {}), item.metric?.route].filter(Boolean))].join(' ');
    byInstance[key] = Math.max(byInstance[key] ?? -Infinity, value);
  }
  const values = Object.values(byInstance);
  return values.length ? { max: Math.max(...values), byInstance } : null;
}

export async function instantQuery(prom, query, { fetchImpl = fetch, headers = {}, timeoutMs = 8000 } = {}) {
  const url = `${prom.url.replace(/\/$/, '')}/api/v1/query?${new URLSearchParams({ query })}`;
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Prometheus HTTP ${response.status}`);
  const body = await response.json();
  if (body.status !== 'success') throw new Error(`Prometheus error: ${body.error ?? 'unknown'}`);
  return summarizeVector(body.data?.result);
}

/** Runs every configured query; a failing query yields `null` for that query only. */
export async function sampleQueries(prom, options) {
  const out = {};
  await Promise.all((prom.queries ?? []).map(async (q) => {
    try { out[q.name] = await instantQuery(prom, q.query, options); } catch { out[q.name] = null; }
  }));
  return out;
}
