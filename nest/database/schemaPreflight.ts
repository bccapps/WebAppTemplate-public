/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Everything done to a database BEFORE TypeORM applies the schema (`DatabaseModule` calls it once per connection):
 * the guard rails (`schemaGuard.ts`) and, for an existing SQLite file, the version-change backup (`sqliteBackup.ts`).
 */

import type { DataSourceOptions } from 'typeorm';
import { schemaResolutionOf, type DbContext } from './databases';
import { runSchemaGuard } from './schemaGuard';
import { backupSqliteIfVersionChanged, resolveAppVersion } from './sqliteBackup';

export async function prepareSchema(options: DataSourceOptions, context?: Pick<DbContext, 'certBaseDir'>): Promise<void> {
  const entry = schemaResolutionOf(options);
  if (!entry) return;
  const { connection, resolution } = entry;
  // Backup FIRST: the guard's probe connection creates a missing SQLite file, which would make a brand-new database look like an
  // existing one. A failing guard after a backup leaves one harmless copy (the version is then recorded, no repeat on the next boot).
  const appliesSchema = resolution.synchronize || resolution.migrationsRun;
  if (options.type === 'better-sqlite3' && appliesSchema && resolution.source !== 'cli') {
    const database = (options as { database?: string }).database;
    if (database) {
      const required = ['true', '1'].includes((process.env.DB_BACKUP_REQUIRED ?? '').trim().toLowerCase());
      await backupSqliteIfVersionChanged(database, resolveAppVersion([context?.certBaseDir ?? process.cwd(), process.cwd()]), { required });
    }
  }
  await runSchemaGuard(options, resolution, connection);
}
