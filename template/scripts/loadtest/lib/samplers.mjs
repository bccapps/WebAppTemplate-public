/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Health samplers: Postgres (connections, slow statements), Redis (memory, ops) and the load generator itself.
 * `pg` and `ioredis` are resolved from the project's own back (see `requireFromProject`): the template has no
 * node_modules. Postgres queries here are read-only and Postgres-specific on purpose (this is a monitoring tool,
 * not application code).
 */

import os from 'node:os';

/** `INFO` text → flat object (section headers and blank lines ignored). */
export function parseInfo(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const eq = line.indexOf(':');
    if (!line || line.startsWith('#') || eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

export function redisSampleFromInfo(info) {
  const num = (key) => (info[key] === undefined ? null : Number(info[key]));
  return {
    usedMemory: num('used_memory'),
    maxMemory: num('maxmemory') ?? 0,
    opsPerSec: num('instantaneous_ops_per_sec'),
    totalCommands: num('total_commands_processed'),
    clients: num('connected_clients'),
  };
}

export async function sampleRedis(client) {
  return redisSampleFromInfo(parseInfo(await client.info()));
}

export function sampleGenerator(osImpl = os) {
  const cores = osImpl.cpus().length || 1;
  const load1 = osImpl.loadavg()[0];
  return { load1, cores, loadRatio: load1 / cores, freeMemMb: Math.round(osImpl.freemem() / 1048576) };
}

const PG_ACTIVITY_SQL = `
  SELECT count(*)::int AS connections,
         count(*) FILTER (WHERE state = 'active')::int AS active,
         count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_tx,
         count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS lock_waiting
  FROM pg_stat_activity WHERE datname = current_database()`;

const PG_CACHE_SQL = `
  SELECT round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2)::float AS cache_hit
  FROM pg_stat_database WHERE datname = current_database()`;

export async function samplePostgres(client) {
  const [activity, cache, max] = await Promise.all([
    client.query(PG_ACTIVITY_SQL),
    client.query(PG_CACHE_SQL),
    client.query('SHOW max_connections'),
  ]);
  const row = activity.rows[0];
  return {
    connections: row.connections,
    active: row.active,
    idleInTx: row.idle_in_tx,
    lockWaiting: row.lock_waiting,
    cacheHit: cache.rows[0]?.cache_hit ?? null,
    maxConnections: Number(max.rows[0]?.max_connections ?? 0),
  };
}

const STATEMENTS_SQL = `
  SELECT queryid::text AS queryid, left(regexp_replace(query, '\\s+', ' ', 'g'), 140) AS query,
         calls::float AS calls, total_exec_time::float AS total_ms
  FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  ORDER BY total_exec_time DESC LIMIT 200`;

/** Snapshot of `pg_stat_statements` (empty when the extension is unavailable). */
export async function snapshotStatements(client) {
  try { return (await client.query(STATEMENTS_SQL)).rows; } catch { return []; }
}

/** Statements ranked by the time they consumed between two snapshots. */
export function diffStatements(before, after, top = 10) {
  const previous = new Map(before.map((row) => [row.queryid, row]));
  return after
    .map((row) => {
      const old = previous.get(row.queryid);
      const calls = row.calls - (old?.calls ?? 0);
      const totalMs = row.total_ms - (old?.total_ms ?? 0);
      return { query: row.query, calls, totalMs, meanMs: calls > 0 ? totalMs / calls : 0 };
    })
    .filter((row) => row.calls > 0)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, top);
}

/** Strips `sslmode` from a connection URL: SSL is decided by the explicit `ssl` option instead. */
export function pgConnectionOptions(url, verifySsl) {
  const parsed = new URL(url);
  const sslMode = parsed.searchParams.get('sslmode');
  parsed.searchParams.delete('sslmode');
  const useSsl = sslMode !== 'disable';
  return { connectionString: parsed.toString(), ssl: useSsl ? { rejectUnauthorized: Boolean(verifySsl) } : false, max: 1 };
}

export async function openPostgres(pgModule, url, verifySsl) {
  const client = new pgModule.Client(pgConnectionOptions(url, verifySsl));
  await client.connect();
  return client;
}

export async function openRedis(IORedis, url) {
  const client = new IORedis(url, {
    lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5000,
    tls: url.startsWith('rediss://') ? {} : undefined,
  });
  await client.connect();
  return client;
}
