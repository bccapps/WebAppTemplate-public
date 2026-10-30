/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Turns the raw artefacts of a run (k6 summary, monitoring samples, run metadata) into a verdict per tier,
 * an extrapolation of the saturation point and a Markdown report. Pure functions.
 */

import { fmt, slug } from './util.mjs';

const metricValues = (summary, name) => summary?.metrics?.[name]?.values ?? {};

/** Headline numbers of one tier from the k6 `handleSummary` data. */
export function k6Digest(summary, pageNames = []) {
  const duration = metricValues(summary, 'http_req_duration');
  const pages = {};
  for (const name of pageNames) {
    const v = metricValues(summary, `page_ms_${slug(name)}`);
    // k6 only exports the configured trend stats (no `count`): a page that ran has at least a p95.
    if (v['p(95)'] !== undefined) pages[name] = { avg: v.avg, p95: v['p(95)'] };
  }
  return {
    requests: metricValues(summary, 'http_reqs').count ?? 0,
    rps: metricValues(summary, 'http_reqs').rate ?? 0,
    errorRate: metricValues(summary, 'http_req_failed').rate ?? 0,
    p50: duration.med, p90: duration['p(90)'], p95: duration['p(95)'], p99: duration['p(99)'], max: duration.max,
    status429: metricValues(summary, 'status_429').count ?? 0,
    status5xx: metricValues(summary, 'status_5xx').count ?? 0,
    receivedMb: (metricValues(summary, 'data_received').count ?? 0) / 1048576,
    pages,
  };
}

/** Peak of every monitored quantity over the samples of a tier. */
export function peaks(samples) {
  const out = { prom: {}, pg: {}, redis: {}, gen: {} };
  for (const sample of samples) {
    for (const [name, value] of Object.entries(sample.prom ?? {})) {
      if (!value) continue;
      const prev = out.prom[name];
      if (!prev || value.max > prev.max) {
        const worst = Object.entries(value.byInstance ?? {}).sort((a, b) => b[1] - a[1])[0];
        out.prom[name] = { max: value.max, worst: worst?.[0] ?? '' };
      }
    }
    for (const part of ['pg', 'redis', 'gen']) {
      for (const [key, value] of Object.entries(sample[part] ?? {})) {
        if (typeof value === 'number') out[part][key] = Math.max(out[part][key] ?? -Infinity, value);
      }
    }
  }
  return out;
}

/** `OK` or `FAIL` with the reasons, against the configured limits. */
export function verdict(digest, meta, limits) {
  const reasons = [];
  if (meta.aborted) reasons.push(`aborted: ${meta.abortReason}`);
  if (digest.errorRate > limits.maxErrorRate) reasons.push(`errors ${fmt(digest.errorRate * 100)}% > ${limits.maxErrorRate * 100}%`);
  if (digest.p95 > limits.maxP95Ms) reasons.push(`p95 ${fmt(digest.p95, 0)}ms > ${limits.maxP95Ms}ms`);
  if (digest.status429 > 0) reasons.push(`${digest.status429} rate-limited (429)`);
  return { ok: reasons.length === 0, reasons };
}

/** Least-squares line through `[x, y]` points. */
export function linearFit(points) {
  const n = points.length;
  const sx = points.reduce((s, [x]) => s + x, 0);
  const sy = points.reduce((s, [, y]) => s + y, 0);
  const sxx = points.reduce((s, [x]) => s + x * x, 0);
  const sxy = points.reduce((s, [x, y]) => s + x * y, 0);
  const denom = n * sxx - sx * sx;
  if (n < 2 || denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

/** Concurrency at which the fitted line reaches `limit`; null when there is no upward trend or < 3 points. */
export function extrapolate(points, limit) {
  if (points.length < 3) return null;
  const fit = linearFit(points);
  if (!fit || fit.slope <= 0) return null;
  const x = (limit - fit.intercept) / fit.slope;
  return x > 0 ? Math.round(x) : null;
}

function extrapolations(tiers, cfg) {
  const rows = [];
  const p95Points = tiers.map((t) => [t.plan.concurrent, t.digest.p95]).filter(([, y]) => Number.isFinite(y));
  rows.push({ metric: `p95 latency (limit ${cfg.limits.maxP95Ms} ms)`, at: extrapolate(p95Points, cfg.limits.maxP95Ms) });
  for (const query of cfg.monitor.prometheus?.queries ?? []) {
    if (query.guard?.max === undefined) continue;
    const points = tiers.map((t) => [t.plan.concurrent, t.peaks.prom[query.name]?.max]).filter(([, y]) => Number.isFinite(y));
    rows.push({ metric: `${query.name} (limit ${query.guard.max}${query.unit ?? ''})`, at: extrapolate(points, query.guard.max) });
  }
  return rows;
}

const table = (header, rows) => [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

function summarySection(tiers, limits) {
  return table(
    ['Tier', 'Sessions', 'Req', 'req/s', 'p50 ms', 'p95 ms', 'p99 ms', 'Errors %', '429', '5xx', 'Verdict'],
    tiers.map((t) => {
      const v = verdict(t.digest, t.meta, limits);
      const d = t.digest;
      return [t.plan.name, t.plan.concurrent, d.requests, fmt(d.rps), fmt(d.p50, 0), fmt(d.p95, 0), fmt(d.p99, 0),
        fmt(d.errorRate * 100, 2), d.status429, d.status5xx, v.ok ? 'OK' : `FAIL — ${v.reasons.join('; ')}`];
    }),
  );
}

function resourcesSection(tiers, cfg) {
  const queries = cfg.monitor.prometheus?.queries ?? [];
  const header = ['Tier', ...queries.map((q) => q.name), 'PG conns', 'Redis ops/s', 'Redis MB', 'Generator load'];
  return table(header, tiers.map((t) => [
    t.plan.name,
    ...queries.map((q) => { const p = t.peaks.prom[q.name]; return p ? `${fmt(p.max)}${q.unit ?? ''} (${p.worst})` : '–'; }),
    `${fmt(t.peaks.pg.connections, 0)}${t.peaks.pg.maxConnections ? ` / ${fmt(t.peaks.pg.maxConnections, 0)}` : ''}`, fmt(t.peaks.redis.opsPerSec, 0), fmt((t.peaks.redis.usedMemory ?? NaN) / 1048576), fmt(t.peaks.gen.loadRatio, 2),
  ]));
}

function pagesSection(tiers) {
  const names = [...new Set(tiers.flatMap((t) => Object.keys(t.digest.pages)))];
  if (!names.length) return '_No page timings recorded._';
  return table(['Page (p95 ms)', ...tiers.map((t) => t.plan.name)], names.map((n) => [n, ...tiers.map((t) => fmt(t.digest.pages[n]?.p95, 0))]));
}

function statementsSection(tiers) {
  const lines = tiers.filter((t) => t.meta.statements?.length).map((t) =>
    `**${t.plan.name}**\n\n${table(['Calls', 'Total ms', 'Mean ms', 'Statement'], t.meta.statements.slice(0, 5).map((s) => [fmt(s.calls, 0), fmt(s.totalMs, 0), fmt(s.meanMs, 2), `\`${s.query.replace(/\|/g, '\\|')}\``]))}`);
  return lines.length ? lines.join('\n\n') : '_`pg_stat_statements` unavailable or Postgres sampling disabled._';
}

function quotaSection(tiers) {
  return table(['Tier', 'Redis commands (measured)', 'Redis commands (estimated)'],
    tiers.map((t) => [t.plan.name, t.meta.redisCommandsDelta ?? '–', t.estimate.redisOpsTotal]));
}

/** Markdown report of a whole run. `tiers` = [{ plan, estimate, digest, peaks, meta }]. */
export function renderReport({ cfg, runId, tiers }) {
  const extra = extrapolations(tiers, cfg)
    .map((row) => `- ${row.metric}: ${row.at ? `reached around **${row.at} simultaneous sessions**` : 'no upward trend / not enough tiers'}`);
  return [
    `# Load test report — ${runId}`,
    `Target API: ${cfg.targets.api}  \nFront: ${cfg.targets.front ?? '–'}`,
    '## Results per tier', summarySection(tiers, cfg.limits),
    '## Peak resource usage', resourcesSection(tiers, cfg),
    '## Page latency (p95)', pagesSection(tiers),
    '## Quota consumption', quotaSection(tiers),
    '## Heaviest SQL statements during the tier', statementsSection(tiers),
    '## Extrapolation (linear fit over the tiers run — indicative only, needs ≥ 3 tiers)', extra.join('\n'),
    '## Reading notes\n- Prometheus values are instant queries sampled every few seconds; the peak is the highest sample.\n- A 429 means the rate limiter answered: the tier measured the limiter, not the capacity.\n- Supabase egress and the provider dashboards are not readable from here: compare them before and after the run.',
  ].join('\n\n') + '\n';
}
