/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { join } from 'path';
import { DataSource } from 'typeorm';
import { buildMainDataSourceOptions, DbContext } from '../modules_shared/database';

/**
 * Project-local database wiring. Env parsing and multi-connection build live in
 * the shared `modules_shared/database` module; this file only resolves
 * project-specific paths from its own __dirname and exposes the "main"
 * DataSource for the TypeORM CLI / migrations.
 */
export const dbContext: DbContext = {
  baseDir: join(__dirname, '..'), // src/
  certBaseDir: join(__dirname, '..', '..'), // back/ — base for DB_SSLROOTCERT
  migrationGlobs: [join(__dirname, '../migrations/*.{js,ts}')],
};

const AppDataSource = new DataSource(buildMainDataSourceOptions(dbContext));
export default AppDataSource;
