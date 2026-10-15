/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * End to end on a real SQLite file: options built from the environment, `prepareSchema` (what `DatabaseModule` runs), then TypeORM
 * applies the schema. Proves the ORDER: the backup of the previous release is taken BEFORE `synchronize` rewrites a table.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';
import { buildMainDataSourceOptions } from './databases';
import { prepareSchema } from './schemaPreflight';

let driverAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('better-sqlite3');
} catch {
  driverAvailable = false;
}
const sqliteIt = driverAvailable ? it : it.skip;

@Entity({ name: 'boot_items' })
class BootItemV1 {
  @PrimaryColumn() id!: number;
  @Column({ type: 'varchar', nullable: true }) legacy!: string | null;
}

@Entity({ name: 'boot_items' })
class BootItemV2 {
  @PrimaryColumn() id!: number;
  // `legacy` was REMOVED in this release: synchronize recreates the table without it.
  @Column({ type: 'varchar', nullable: true }) added!: string | null;
}

describe('SQLite boot: backup, then schema', () => {
  const KEYS = ['DB_ENGINE', 'DB_PATH', 'DB_SCHEMA_MODE', 'APP_VERSION', 'TYPEORM_SYNC', 'DB_SYNC', 'DB_MIGRATIONS_RUN', 'DB_SQLITE_MIGRATIONS', 'NODE_ENV'];
  let saved: Record<string, string | undefined>;
  let dir: string;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'vx-boot-'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const boot = async (entity: unknown, version: string): Promise<DataSource> => {
    process.env.DB_ENGINE = 'sqlite';
    process.env.DB_PATH = join(dir, 'app.db');
    process.env.DB_SCHEMA_MODE = 'sync';
    process.env.APP_VERSION = version;
    const ctx = { baseDir: join(dir, 'src'), migrationGlobs: [join(dir, 'src/migrations/*.{js,ts}')], certBaseDir: dir };
    // `prepareSchema` finds the recorded resolution through the options object: build once, then swap the entity set in place.
    const built = buildMainDataSourceOptions(ctx, { cli: false });
    Object.assign(built, { entities: [entity as never] });
    await prepareSchema(built, ctx);
    const ds = new DataSource(built);
    await ds.initialize();
    return ds;
  };

  sqliteIt('creates the schema on the first boot (no backup), then keeps the old release safe across an incompatible update', async () => {
    const first = await boot(BootItemV1, '1.0.0');
    await first.query("INSERT INTO boot_items (id, legacy) VALUES (1, 'precious')");
    await first.destroy();
    expect(readdirSync(dir).filter((n) => n.includes('.bak-'))).toEqual([]);
    expect(readFileSync(join(dir, 'app.db.version'), 'utf8').trim()).toBe('1.0.0');

    // Same version again: nothing copied.
    await (await boot(BootItemV1, '1.0.0')).destroy();
    expect(readdirSync(dir).filter((n) => n.includes('.bak-') && !/-(wal|shm)$/.test(n))).toEqual([]);

    // New release removes a column: synchronize drops it — the backup taken before keeps it.
    const second = await boot(BootItemV2, '2.0.0');
    const columns = (await second.query('PRAGMA table_info(boot_items)')) as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual(['id', 'added']);
    await second.destroy();

    const backups = readdirSync(dir).filter((n) => n.includes('.bak-1.0.0-') && !/-(wal|shm)$/.test(n));
    expect(backups).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const copy = new Database(join(dir, backups[0] as string), { readonly: true });
    expect(copy.prepare('SELECT legacy FROM boot_items WHERE id = 1').get()).toEqual({ legacy: 'precious' });
    copy.close();
    expect(existsSync(join(dir, 'app.db.version'))).toBe(true);
    expect(readFileSync(join(dir, 'app.db.version'), 'utf8').trim()).toBe('2.0.0');
  });
});
