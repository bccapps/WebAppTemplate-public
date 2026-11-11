/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * The reference DDL of SQLite (`interaction.sqlite.sql`, for apps in `migrations` / `manual` mode) is what TypeORM creates
 * from the entities: a drift fails here. `INTERACTION_WRITE_DDL=1` rewrites the file. Needs `better-sqlite3`.
 */
import { restoreEngineEnv } from '../testing/sqliteEngineEnv';
import { afterAll, describe, expect, it } from '@jest/globals';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { INTERACTION_ENTITIES } from '../interactionEntities';

const file = join(__dirname, 'interaction.sqlite.sql');
const hasDriver = ((): boolean => {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();

afterAll(restoreEngineEnv);

(hasDriver ? describe : describe.skip)('interaction reference DDL — SQLite', () => {
  it('matches the entities', async () => {
    const dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: INTERACTION_ENTITIES, synchronize: true });
    await dataSource.initialize();
    const rows: Array<{ sql: string }> = await dataSource.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name");
    await dataSource.destroy();
    const ddl = `-- Reference DDL of the interaction module (SQLite), generated from the entities by ddl.sqlite.spec.ts.\n\n${rows.map((row) => `${row.sql};`).join('\n\n')}\n`;
    if (process.env.INTERACTION_WRITE_DDL === '1') writeFileSync(file, ddl);
    expect(readFileSync(file, 'utf8')).toBe(ddl);
  });
});
