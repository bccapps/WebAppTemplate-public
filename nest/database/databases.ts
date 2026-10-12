/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Builds TypeORM `DataSourceOptions` for one or many database connections from
 * environment variables. Project-agnostic: entity/migration locations are
 * passed in via `DbContext` (resolved by each project from its own __dirname),
 * never derived from this file's location (it lives in a shared library and is
 * symlinked/compiled inside every consuming project).
 *
 * Env per connection:
 *   main:        DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME /
 *                DB_SSLMODE / DB_SSLROOTCERT / DB_POOLSIZE /
 *                DATABASE_ENGINE / TYPEORM_SYNC
 *   named "<N>": DB__<N>__HOST / DB__<N>__PORT / DB__<N>__USER /
 *                DB__<N>__PASSWORD / DB__<N>__NAME / DB__<N>__SSLMODE /
 *                DB__<N>__SSLROOTCERT / DB__<N>__POOLSIZE /
 *                DB__<N>__ENGINE / DB__<N>__SYNC
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { DataSourceOptions } from 'typeorm';
import {
  MAIN_CONNECTION,
  dbFor,
  isRoutingActive,
  parseConnectionNames,
} from './dbRouting';

/** Project-specific locations, resolved by the consuming project. */
export interface DbContext {
  /** `src` directory — used to glob module entities. */
  baseDir: string;
  /** Migration globs (only applied to the "main" connection). */
  migrationGlobs: string[];
  /** Base dir for resolving `DB_SSLROOTCERT` (the `back` root). Defaults to cwd. */
  certBaseDir?: string;
}

/** Recursive globs used by the dormant single-connection case (legacy behaviour). */
const standardGlobs = (baseDir: string): string[] => [
  join(baseDir, 'modules_shared/**/entities/*.{js,ts}'),
  join(baseDir, 'modules/**/entities/*.{js,ts}'),
];

/** List `{ id, entityGlob }` for every module folder that has an `entities/` dir. */
function listModuleEntityGlobs(baseDir: string): { id: string; glob: string }[] {
  const out: { id: string; glob: string }[] = [];
  for (const area of ['modules', 'modules_shared']) {
    const areaDir = join(baseDir, area);
    if (!existsSync(areaDir)) continue;
    for (const id of readdirSync(areaDir)) {
      // existsSync follows symlinks → works for symlinked modules_shared.
      if (existsSync(join(areaDir, id, 'entities'))) {
        out.push({ id, glob: join(areaDir, id, 'entities', '*.{js,ts}') });
      }
    }
  }
  return out;
}

/**
 * Map of connection name → entity globs.
 * - Dormant (no routing): one "main" connection with the standard recursive
 *   globs — strictly identical to the legacy single-DataSource entity set.
 * - Active: every module is assigned to its routed connection; "main" keeps
 *   everything not routed elsewhere. Per-module globs avoid loading the same
 *   entity into two connections (which would duplicate tables under synchronize).
 */
export function resolveEntityGlobs(baseDir: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!isRoutingActive()) {
    map.set(MAIN_CONNECTION, standardGlobs(baseDir));
    return map;
  }
  map.set(MAIN_CONNECTION, []);
  for (const name of parseConnectionNames()) map.set(name, []);
  for (const { id, glob } of listModuleEntityGlobs(baseDir)) {
    const conn = dbFor(id);
    if (!map.has(conn)) map.set(conn, []);
    map.get(conn)!.push(glob);
  }
  return map;
}

/** Build `DataSourceOptions` for a single connection from its env prefix. */
function buildConnectionOptions(
  name: string,
  entities: string[],
  ctx: DbContext
): DataSourceOptions {
  const isMain = name === MAIN_CONNECTION;
  const prefix = isMain ? 'DB_' : `DB__${name.toUpperCase()}__`;
  const get = (key: string, legacy?: string): string | undefined =>
    process.env[prefix + key] ?? (isMain && legacy ? process.env[legacy] : undefined);

  const engine = (get('ENGINE', 'DATABASE_ENGINE') ?? 'postgres').toLowerCase();
  const isCloud = ['cloud', 'neon', 'supabase'].includes(engine);

  const host = get('HOST') ?? 'localhost';
  const port = parseInt(get('PORT') ?? '5432', 10);
  const username = get('USER') ?? 'postgres';
  const password = get('PASSWORD') ?? '';
  const database = get('NAME') ?? username;

  const rawPoolSize = get('POOLSIZE')?.trim();
  const poolSize = rawPoolSize ? parseInt(rawPoolSize, 10) : undefined;

  const rawSslMode = get('SSLMODE')?.trim().toLowerCase();
  const sslMode = ['false', '0', 'off'].includes(rawSslMode ?? '')
    ? 'disable'
    : rawSslMode;
  const shouldUseSsl = Boolean(sslMode && sslMode !== 'disable');

  let sslConfig: { rejectUnauthorized?: boolean; ca?: string } | undefined;
  let extra: Record<string, unknown> | undefined;

  if (shouldUseSsl && sslMode) {
    const sslRootCert = get('SSLROOTCERT')?.trim();
    sslConfig = { rejectUnauthorized: sslMode !== 'require-unauthorized' };

    if (sslRootCert) {
      const rootCertPath = join(ctx.certBaseDir ?? process.cwd(), sslRootCert);
      if (!existsSync(rootCertPath)) {
        throw new Error(
          `DB_SSLROOTCERT file "${sslRootCert}" not found at ${rootCertPath}`
        );
      }
      sslConfig.ca = readFileSync(rootCertPath, 'utf8');
    }

    extra = { ssl: sslConfig, sslmode: sslMode };
  } else if (isCloud) {
    sslConfig = { rejectUnauthorized: false };
    extra = { ssl: sslConfig };
  }

  // Cloud-specific pool tuning (Neon/Supabase pgBouncer-friendly).
  // `max` MUST honour DB_POOLSIZE: TypeORM merges `extra` OVER its own
  // { max: poolSize } (PostgresDriver.createPool), so a hardcoded value here
  // would silently win over the env var. Poolers cap the TOTAL number of client
  // connections (Supabase session mode: "max clients are limited to pool_size"),
  // so the budget must be split across every instance (api replicas + worker).
  if (isCloud) {
    extra = {
      ...extra,
      max: poolSize && Number.isFinite(poolSize) ? poolSize : 10,
      // Session-mode poolers (Supabase port 5432) cap the TOTAL client budget project-wide
      // (Supavisor "Pool Size", e.g. 15 on the free tier) — every idle connection this app
      // holds onto is a slot unavailable to another instance/admin tool sharing that budget.
      // Kept short so idle connections are handed back quickly between traffic bursts.
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      // TCP keepalive: without it, a connection silently dropped by the
      // pooler/an intermediary (Supavisor transaction mode, NAT, load
      // balancer) looks alive to the pg pool until the next query is sent on
      // it, which then fails with "Connection terminated unexpectedly"
      // instead of the pool detecting and replacing the dead client first.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      options: engine === 'neon' ? '-c statement_timeout=30000' : undefined,
    };
    // Printed at boot so a pooler's "max clients reached" error (session mode: the limit is
    // on the pooler's TOTAL client budget, not just this instance) can be diagnosed from
    // deploy logs alone, without falling back to a live pg_stat_activity query.
    console.log(`[DB] "${name}" pool: max=${extra.max} (${engine}, ${port === 5432 ? 'session mode — counts against the project-wide pool_size' : 'transaction mode — no total-client cap'})`);
  }

  const syncRaw = get('SYNC', 'TYPEORM_SYNC')?.trim().toLowerCase();
  // Default: enabled in development, DISABLED in production to prevent accidental data loss.
  // Set DB_SYNC=true (or TYPEORM_SYNC=true) in back/.env to override during a controlled migration.
  const syncDefault = process.env.NODE_ENV !== 'production';
  const synchronize = syncRaw ? syncRaw === 'true' || syncRaw === '1' : syncDefault;
  if (!synchronize && !syncRaw) {
    console.warn(
      '[DB] synchronize=false (production default). ' +
      'Schema changes will NOT be applied automatically. ' +
      'Set DB_SYNC=true in back/.env if you need to run a controlled schema migration.',
    );
  }

  return {
    ...(isMain ? {} : { name }),
    type: 'postgres',
    host,
    port,
    username,
    password,
    database,
    entities,
    migrations: isMain ? ctx.migrationGlobs : [],
    synchronize,
    logging: ['error'],
    ...(poolSize && Number.isFinite(poolSize) ? { poolSize } : {}),
    ...(sslConfig ? { ssl: sslConfig } : {}),
    ...(extra ? { extra } : {}),
  } as DataSourceOptions;
}

/** Options for the "main" (default) connection — also used by the TypeORM CLI. */
export function buildMainDataSourceOptions(ctx: DbContext): DataSourceOptions {
  const globs = resolveEntityGlobs(ctx.baseDir).get(MAIN_CONNECTION) ?? [];
  return buildConnectionOptions(MAIN_CONNECTION, globs, ctx);
}

/** Options for every additional named connection (empty when dormant). */
export function buildExtraDataSourceOptions(
  ctx: DbContext
): { name: string; options: DataSourceOptions }[] {
  const map = resolveEntityGlobs(ctx.baseDir);
  const out: { name: string; options: DataSourceOptions }[] = [];
  for (const [name, globs] of map) {
    if (name === MAIN_CONNECTION) continue;
    out.push({ name, options: buildConnectionOptions(name, globs, ctx) });
  }
  return out;
}
