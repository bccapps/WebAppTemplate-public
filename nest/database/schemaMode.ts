/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Schema management of one connection: how its tables get created and evolved at boot.
 *
 * ONE pure function (`resolveSchemaMode`) decides, from the environment only, the three TypeORM options that matter —
 * `synchronize`, `migrationsRun` and whether the migrations are loaded — so the behaviour is the same for every app and both
 * engines, documented in one table (`README.md`, "Schema management") and pinned by tests.
 *
 * Resolution order:
 *   1. the TypeORM CLI (`typeorm migration:run`…): migrations always loaded, never synchronized, never auto-run;
 *   2. `DB_SCHEMA_MODE` = `sync` | `migrations` | `manual` (explicit, wins over everything below);
 *   3. LEGACY flags, resolved exactly as before `DB_SCHEMA_MODE` existed (apps in production depend on it):
 *        Postgres: `DB_SYNC`/`TYPEORM_SYNC` → synchronize (default: NODE_ENV !== 'production'), `DB_MIGRATIONS_RUN` →
 *                  migrationsRun, independent flags, migrations always loaded;
 *        SQLite:   `DB_MIGRATIONS_RUN` or `DB_SQLITE_MIGRATIONS` true → the app has its own migrations (loaded, `synchronize`
 *                  resolved like Postgres), otherwise the schema comes from `synchronize` (default ON, migrations not loaded).
 *   The pre-`DB_SCHEMA_MODE` table is frozen in `schemaMode.legacy.fixture.json` / `schemaMode.characterization.spec.ts`.
 */

export const SCHEMA_MODES = ['sync', 'migrations', 'manual'] as const;
export type SchemaMode = (typeof SCHEMA_MODES)[number];

export type SchemaEngine = 'postgres' | 'sqlite';

export type EnvGetter = (key: string, legacy?: string) => string | undefined;

export interface SchemaResolution {
  /**
   * The mode in force. `mixed` only comes from LEGACY flags that set both `synchronize` and `migrationsRun` (possible on
   * Postgres, kept as is); `DB_SCHEMA_MODE` never produces it.
   */
  mode: SchemaMode | 'mixed';
  synchronize: boolean;
  migrationsRun: boolean;
  /** The migration files are loaded into the DataSource (only ever applied to the main connection by the caller). */
  loadMigrations: boolean;
  /** Where the decision comes from, for the boot log: `[DB] schema mode: <mode> (<reason>)`. */
  reason: string;
  /** Where it comes from: the CLI, `DB_SCHEMA_MODE`, or the legacy flags. */
  source: 'cli' | 'DB_SCHEMA_MODE' | 'legacy';
  /** Messages to print once (same wording as before for the legacy ones). */
  warnings: string[];
}

export interface ResolveOptions {
  /** The caller is the TypeORM CLI. */
  cli?: boolean;
  /** `process.env.NODE_ENV` (injectable for tests). */
  nodeEnv?: string;
  /** Env prefix shown in error messages (`DB_` for the main connection). */
  prefix?: string;
}

const isTrue = (value: string | undefined): boolean => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === 'true' || trimmed === '1';
};

const modeOf = (synchronize: boolean, migrationsRun: boolean): SchemaResolution['mode'] =>
  synchronize && migrationsRun ? 'mixed' : synchronize ? 'sync' : migrationsRun ? 'migrations' : 'manual';

/** `synchronize` from `DB_SYNC`/`TYPEORM_SYNC`; `undefined` = not set (the caller applies the engine default). */
function explicitSync(get: EnvGetter): boolean | undefined {
  const raw = get('SYNC', 'TYPEORM_SYNC')?.trim().toLowerCase();
  return raw ? raw === 'true' || raw === '1' : undefined;
}

/** The historical wording, kept verbatim. */
const NO_SYNC_WARNING =
  '[DB] synchronize=false (production default). ' +
  'Schema changes will NOT be applied automatically. ' +
  'Set DB_SYNC=true in back/.env if you need to run a controlled schema migration.';

const PRODUCTION_SYNC_WARNING =
  '[DB] synchronize=true with NODE_ENV=production: entity changes (renamed/removed columns, changed types) are applied to the ' +
  'database at boot and can DROP data. Prefer DB_SCHEMA_MODE=migrations, or back the database up before each release.';

/** Resolve the schema management of one connection. Pure: reads nothing but `get` and `opts`. */
export function resolveSchemaMode(engine: SchemaEngine, get: EnvGetter, opts: ResolveOptions = {}): SchemaResolution {
  const nodeEnv = opts.nodeEnv;
  const prefix = opts.prefix ?? 'DB_';
  const warnings: string[] = [];

  if (opts.cli) {
    return {
      mode: 'manual',
      synchronize: false,
      migrationsRun: false,
      loadMigrations: true,
      reason: 'typeorm CLI: migrations always loaded, never synchronized nor auto-run',
      source: 'cli',
      warnings,
    };
  }

  const explicit = get('SCHEMA_MODE')?.trim().toLowerCase();
  if (explicit) {
    if (!(SCHEMA_MODES as readonly string[]).includes(explicit)) {
      throw new Error(`${prefix}SCHEMA_MODE must be one of: ${SCHEMA_MODES.join(', ')} (got "${get('SCHEMA_MODE')}")`);
    }
    const mode = explicit as SchemaMode;
    if (mode === 'sync' && nodeEnv === 'production' && engine === 'postgres') warnings.push(PRODUCTION_SYNC_WARNING);
    return {
      mode,
      synchronize: mode === 'sync',
      migrationsRun: mode === 'migrations',
      loadMigrations: mode !== 'sync',
      reason: `${prefix}SCHEMA_MODE=${mode}`,
      source: 'DB_SCHEMA_MODE',
      warnings,
    };
  }

  const sync = explicitSync(get);
  const migrationsFlag = isTrue(get('MIGRATIONS_RUN'));

  if (engine === 'sqlite') {
    const ownMigrations = migrationsFlag || isTrue(get('SQLITE_MIGRATIONS'));
    if (!ownMigrations) {
      const synchronize = sync ?? true;
      return {
        mode: synchronize ? 'sync' : 'manual',
        synchronize,
        migrationsRun: false,
        loadMigrations: false,
        reason: sync === undefined ? 'legacy default for SQLite: the schema comes from synchronize' : `legacy ${sync ? 'DB_SYNC/TYPEORM_SYNC=true' : 'DB_SYNC/TYPEORM_SYNC=false'}`,
        source: 'legacy',
        warnings,
      };
    }
    // An SQLite app with its OWN migrations: `synchronize` resolved like Postgres (production default OFF).
    const synchronize = sync ?? nodeEnv !== 'production';
    if (!synchronize && sync === undefined) warnings.push(NO_SYNC_WARNING);
    return {
      mode: modeOf(synchronize, migrationsFlag),
      synchronize,
      migrationsRun: migrationsFlag,
      loadMigrations: true,
      reason: `legacy flags (SQLite app with its own migrations: DB_MIGRATIONS_RUN=${migrationsFlag}, synchronize ${sync === undefined ? 'by default' : 'explicit'})`,
      source: 'legacy',
      warnings,
    };
  }

  const synchronize = sync ?? nodeEnv !== 'production';
  if (!synchronize && sync === undefined) warnings.push(NO_SYNC_WARNING);
  if (synchronize && nodeEnv === 'production') warnings.push(PRODUCTION_SYNC_WARNING);
  return {
    mode: modeOf(synchronize, migrationsFlag),
    synchronize,
    migrationsRun: migrationsFlag,
    loadMigrations: true,
    reason: `legacy flags (synchronize ${sync === undefined ? `by default for NODE_ENV=${nodeEnv ?? 'unset'}` : 'explicit'}, DB_MIGRATIONS_RUN=${migrationsFlag})`,
    source: 'legacy',
    warnings,
  };
}

/**
 * True when the process is the TypeORM CLI (`typeorm migration:run`, `typeorm-ts-node-commonjs`, `npx typeorm …`) or when
 * `TYPEORM_CLI=1` says so. The CLI shares the app's `Datasource.ts` entry: it must see the migrations and must neither
 * synchronize nor auto-run them.
 */
export function detectTypeormCli(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isTrue(env.TYPEORM_CLI)) return true;
  return argv.slice(0, 3).some((arg) => /(^|[\\/])typeorm([\\/]cli(\.js)?|-ts-node-(commonjs|esm)(\.js)?|(\.js)?)$/.test(arg));
}

const logged = new Set<string>();

/** Prints the resolution once per process and connection: `[DB] schema mode: <mode> (<reason>)` + its warnings. */
export function logSchemaMode(connection: string, resolution: SchemaResolution): void {
  const label = connection === 'main' ? '' : ` "${connection}"`;
  const line = `[DB]${label} schema mode: ${resolution.mode} (${resolution.reason})`;
  if (!logged.has(line)) {
    logged.add(line);
    console.log(line);
  }
  for (const warning of resolution.warnings) {
    const key = `${connection}|${warning}`;
    if (logged.has(key)) continue;
    logged.add(key);
    console.warn(warning);
  }
}
