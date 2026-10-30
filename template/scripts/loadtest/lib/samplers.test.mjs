/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffStatements, openPostgres, openRedis, parseInfo, pgConnectionOptions, redisSampleFromInfo, sampleGenerator, samplePostgres, sampleRedis, snapshotStatements } from './samplers.mjs';

test('parseInfo ignores sections and blank lines', () => {
  assert.deepEqual(parseInfo('# Memory\r\nused_memory:100\r\n\r\n# Stats\r\ninstantaneous_ops_per_sec:7\r\n'), { used_memory: '100', instantaneous_ops_per_sec: '7' });
});

test('redisSampleFromInfo maps numbers and tolerates missing fields', () => {
  const sample = redisSampleFromInfo({ used_memory: '2048', instantaneous_ops_per_sec: '12', total_commands_processed: '99' });
  assert.deepEqual(sample, { usedMemory: 2048, maxMemory: 0, opsPerSec: 12, totalCommands: 99, clients: null });
});

test('sampleRedis reads INFO', async () => {
  const out = await sampleRedis({ info: async () => 'used_memory:5\r\nmaxmemory:10\r\n' });
  assert.equal(out.usedMemory, 5);
  assert.equal(out.maxMemory, 10);
});

test('sampleGenerator computes the load ratio', () => {
  const fake = { cpus: () => [1, 2, 3, 4], loadavg: () => [2, 0, 0], freemem: () => 2 * 1048576 };
  assert.deepEqual(sampleGenerator(fake), { load1: 2, cores: 4, loadRatio: 0.5, freeMemMb: 2 });
});

test('samplePostgres assembles activity, cache hit and max_connections', async () => {
  const client = {
    query: async (sql) => {
      if (sql.includes('pg_stat_activity')) return { rows: [{ connections: 12, active: 3, idle_in_tx: 1, lock_waiting: 0 }] };
      if (sql.includes('pg_stat_database')) return { rows: [{ cache_hit: 99.5 }] };
      return { rows: [{ max_connections: '60' }] };
    },
  };
  assert.deepEqual(await samplePostgres(client), { connections: 12, active: 3, idleInTx: 1, lockWaiting: 0, cacheHit: 99.5, maxConnections: 60 });
});

test('snapshotStatements returns [] when pg_stat_statements is unavailable', async () => {
  assert.deepEqual(await snapshotStatements({ query: async () => { throw new Error('relation does not exist'); } }), []);
  assert.equal((await snapshotStatements({ query: async () => ({ rows: [{ queryid: '1' }] }) })).length, 1);
});

test('diffStatements ranks by consumed time and ignores untouched statements', () => {
  const before = [{ queryid: '1', query: 'A', calls: 10, total_ms: 100 }, { queryid: '2', query: 'B', calls: 5, total_ms: 50 }];
  const after = [
    { queryid: '1', query: 'A', calls: 20, total_ms: 400 },
    { queryid: '2', query: 'B', calls: 5, total_ms: 50 },
    { queryid: '3', query: 'C', calls: 4, total_ms: 40 },
  ];
  const out = diffStatements(before, after);
  assert.deepEqual(out.map((r) => r.query), ['A', 'C']);
  assert.equal(out[0].meanMs, 30);
  assert.equal(diffStatements(before, after, 1).length, 1);
});

test('pgConnectionOptions decides SSL explicitly', () => {
  const secure = pgConnectionOptions('postgres://u:p@h:5432/db?sslmode=require', false);
  assert.deepEqual(secure.ssl, { rejectUnauthorized: false });
  assert.ok(!secure.connectionString.includes('sslmode'));
  assert.equal(secure.max, 1);
  assert.equal(pgConnectionOptions('postgres://u:p@h/db?sslmode=disable', false).ssl, false);
  assert.deepEqual(pgConnectionOptions('postgres://u:p@h/db', true).ssl, { rejectUnauthorized: true });
});

test('openPostgres and openRedis connect their client', async () => {
  let pgOptions;
  class Client { constructor(o) { pgOptions = o; } async connect() { this.ok = true; } }
  const client = await openPostgres({ Client }, 'postgres://u:p@h/db', false);
  assert.equal(client.ok, true);
  assert.equal(pgOptions.max, 1);
  let redisArgs;
  class Redis { constructor(...a) { redisArgs = a; } async connect() { this.ok = true; } }
  const redis = await openRedis(Redis, 'rediss://:pw@h:6379');
  assert.equal(redis.ok, true);
  assert.deepEqual(redisArgs[1].tls, {});
});
