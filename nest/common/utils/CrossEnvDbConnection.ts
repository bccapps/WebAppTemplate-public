/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Pool } from 'pg';

export interface TargetConnConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: { rejectUnauthorized: boolean; ca?: string };
}

/** Minimal `KEY=VALUE` .env parser — mirrors `update_prod.sh`'s own `grep '^KEY='` reads. */
export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function buildTargetConfigFromMap(env: Record<string, string | undefined>, certBaseDir: string, sourceLabel: string): TargetConnConfig {
  if (!env.DB_HOST || !env.DB_NAME) {
    throw new BadRequestException(`DB_HOST/DB_NAME missing from ${sourceLabel}`);
  }
  const config: TargetConnConfig = {
    host: env.DB_HOST,
    port: parseInt(env.DB_PORT ?? '5432', 10),
    user: env.DB_USER ?? 'postgres',
    password: env.DB_PASSWORD ?? '',
    database: env.DB_NAME,
  };
  const sslMode = env.DB_SSLMODE?.toLowerCase();
  if (sslMode && !['false', '0', 'off', 'disable'].includes(sslMode)) {
    config.ssl = { rejectUnauthorized: sslMode !== 'require-unauthorized' };
    if (env.DB_SSLROOTCERT) {
      const certPath = join(certBaseDir, env.DB_SSLROOTCERT);
      if (existsSync(certPath)) config.ssl.ca = readFileSync(certPath, 'utf8');
    }
  }
  return config;
}

export function buildTargetConfig(envFilePath: string, certBaseDir: string): TargetConnConfig {
  return buildTargetConfigFromMap(parseEnvFile(envFilePath), certBaseDir, envFilePath);
}

/**
 * Env-var fallback for `buildTargetConfig`, read straight from `process.env` (`CROSSENV_TARGET_DB_*`
 * by default) instead of a file on disk. Exists because a remote deploy driven by `docker --context
 * ssh://… compose --project-directory <local-tmp-dir> up` runs the Compose CLI on the OPERATOR's
 * machine: `env_file:`/`build:` are resolved/streamed client-side (no remote file needed), but a
 * `volumes:` bind mount only ever passes a host PATH to the remote daemon, which resolves it against
 * its OWN filesystem — a local build-context tmpdir path doesn't exist there, so Docker silently
 * creates an empty directory and mounts that instead (`EISDIR` at read time — see deploy-full.sh's
 * `stage_back_env_preprod`, which injects these vars into `back/.env` rather than bind-mounting a
 * file for exactly this reason). Returns `null` (not a thrown error) when unset, so `openTargetPool`
 * can fall back cleanly when neither source is configured.
 */
export function buildTargetConfigFromEnv(certBaseDir: string, prefix = 'CROSSENV_TARGET_'): TargetConnConfig | null {
  const host = process.env[`${prefix}DB_HOST`];
  const name = process.env[`${prefix}DB_NAME`];
  if (!host || !name) return null;
  return buildTargetConfigFromMap(
    {
      DB_HOST: host,
      DB_PORT: process.env[`${prefix}DB_PORT`],
      DB_USER: process.env[`${prefix}DB_USER`],
      DB_PASSWORD: process.env[`${prefix}DB_PASSWORD`],
      DB_NAME: name,
      DB_SSLMODE: process.env[`${prefix}DB_SSLMODE`],
      DB_SSLROOTCERT: process.env[`${prefix}DB_SSLROOTCERT`],
    },
    certBaseDir,
    `${prefix}DB_* environment variables`,
  );
}

export interface Runner {
  query: (sql: string, params?: unknown[]) => Promise<any[]>;
}

/**
 * Adapts a raw `pg` `Pool` to the `Runner` contract. `Pool.query()` resolves
 * to a `QueryResult` (a `{ rows, rowCount, ... }` object, NOT an array) —
 * calling `.map()`/`[0]` directly on it throws at runtime. Every consumer
 * expects `Runner.query()` to resolve to the row array itself (which is what
 * TypeORM's `DataSource.query()` already does natively), so the target pool
 * must be unwrapped through this adapter rather than passed directly.
 */
export function poolRunner(pool: Pool): Runner {
  return { query: (sql, params) => pool.query(sql, params).then((r) => r.rows) };
}

/**
 * Opens a `pg` pool against the target environment, preferring `envFilePath` on disk
 * (`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`/`DB_SSLMODE`/`DB_SSLROOTCERT`, same
 * convention the app's own `DataSource` uses — the natural path for a local/single-host deploy
 * where that file genuinely sits on disk) and falling back to `CROSSENV_TARGET_DB_*` environment
 * variables (see `buildTargetConfigFromEnv`) when it doesn't exist — the only viable path for a
 * `docker --context ssh://…` deploy, where a bind-mounted file is not an option. Refuses if the
 * resolved target resolves to the same host+database the given `dataSource` (the caller's own
 * connection) is already using — guards against a preprod instance accidentally publishing onto
 * itself.
 */
/**
 * Capped well under a typical managed-Postgres pooler's session-mode ceiling (Supabase's default
 * is 15 *total* concurrent session-mode clients for the project, already partly consumed by the
 * target environment's own always-on app pool) — `pg`'s default `max` (10) is exactly the kind of
 * value that, multiplied by the several cross-env publish pools that can be open at once (preview()
 * opens one per domain), blows past that ceiling and surfaces as `EMAXCONNSESSION`. `pg.Pool` queues
 * any query beyond `max` rather than failing, so lowering this only serializes extra concurrency —
 * it never causes a request to fail on its own.
 */
const CROSSENV_POOL_MAX = 3;

export function openTargetPool(dataSource: DataSource, envFilePath: string, certBaseDir: string): Pool {
  const config = existsSync(envFilePath) ? buildTargetConfig(envFilePath, certBaseDir) : buildTargetConfigFromEnv(certBaseDir);
  if (!config) {
    throw new BadRequestException(
      `Target environment not configured: neither ${envFilePath} nor CROSSENV_TARGET_DB_HOST/DB_NAME environment variables are set.`,
    );
  }
  const sourceOptions = dataSource.options as unknown as { host?: string; database?: string };
  if (config.host === sourceOptions.host && config.database === sourceOptions.database) {
    throw new BadRequestException(
      'Target database resolves to the current environment — refusing to publish onto itself (are you running this from preprod?).',
    );
  }
  return new Pool({ ...config, max: CROSSENV_POOL_MAX });
}

/**
 * Guards every prod→preprod publish action (Workshop graphs, CMS content) so it can only run
 * from the actual prod process — not just "not the target", but "not preprod/dev either".
 * `openTargetPool`'s self-targeting check alone isn't a substitute: it only rejects a source
 * that happens to resolve to the same DB as the target, which is incidental (e.g. `back/.env.dev`
 * and `back/.env.preprod` currently point at the exact same database) rather than a deliberate
 * environment check. Call this first, before `openTargetPool`, in every `preview()`/`publish()`.
 * Mirrors this app's own "backend must replicate a frontend-only gate" convention (see
 * `@RequireFeature` in `nestcommon/common/decorators`) — the frontend disables the publish
 * button outside prod, but that alone is bypassable via a direct API call.
 */
export function assertProductionEnvironment(): void {
  if (process.env.APP_ENV !== 'prod') {
    throw new BadRequestException('This action is only available when running in the production environment.');
  }
}
