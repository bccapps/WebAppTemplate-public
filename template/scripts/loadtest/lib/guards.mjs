/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Safety nets evaluated on every monitoring sample: a breach makes the runner stop k6 gracefully.
 * A sample is `{ prom: { <query>: { max, byInstance } }, pg: {...}, redis: {...}, gen: {...} }`; any part may be absent.
 */

const breach = (source, metric, value, limit, detail = '') => ({ source, metric, value, limit, detail });

function promBreaches(sample, queries) {
  const out = [];
  for (const query of queries ?? []) {
    const max = query.guard?.max;
    const current = sample.prom?.[query.name];
    if (max === undefined || !current || !(current.max > max)) continue;
    const worst = Object.entries(current.byInstance ?? {}).sort((a, b) => b[1] - a[1])[0];
    out.push(breach('prometheus', query.name, current.max, max, worst ? worst[0] : ''));
  }
  return out;
}

function pgBreaches(pg, limits) {
  if (!pg?.maxConnections) return [];
  const limit = pg.maxConnections * limits.pgConnectionsRatio;
  return pg.connections > limit ? [breach('postgres', 'connections', pg.connections, limit, `max_connections=${pg.maxConnections}`)] : [];
}

function redisBreaches(redis, limits, redisCfg) {
  const out = [];
  if (redis?.maxMemory > 0) {
    const limit = redis.maxMemory * limits.redisMemoryRatio;
    if (redis.usedMemory > limit) out.push(breach('redis', 'used_memory', redis.usedMemory, limit, `maxmemory=${redis.maxMemory}`));
  }
  if (redisCfg?.maxOpsPerSec && redis?.opsPerSec > redisCfg.maxOpsPerSec) {
    out.push(breach('redis', 'ops_per_sec', redis.opsPerSec, redisCfg.maxOpsPerSec));
  }
  return out;
}

function generatorBreaches(gen, limits) {
  if (!gen || !(gen.loadRatio > limits.generatorLoadRatio)) return [];
  return [breach('generator', 'load_ratio', gen.loadRatio, limits.generatorLoadRatio, 'load generator saturated: the measurement is no longer valid')];
}

/** Every limit crossed by this sample (empty array = healthy). */
export function checkGuards(sample, cfg) {
  const { limits, monitor } = cfg;
  return [
    ...promBreaches(sample, monitor.prometheus?.queries),
    ...pgBreaches(sample.pg, limits),
    ...redisBreaches(sample.redis, limits, monitor.redis),
    ...generatorBreaches(sample.gen, limits),
  ];
}

export const describeBreach = (b) =>
  `${b.source}/${b.metric} = ${Number(b.value).toFixed(2)} > ${Number(b.limit).toFixed(2)}${b.detail ? ` (${b.detail})` : ''}`;
