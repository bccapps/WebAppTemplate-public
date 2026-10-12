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
import { buildMainDataSourceOptions, DbContext } from 'src/modules_shared/database';

/**
 * Project-local database wiring. Env parsing and multi-connection build live in
 * the shared `modules_shared/database` module; this file only resolves
 * project-specific paths and exposes the "main" DataSource for the TypeORM CLI /
 * migrations.
 *
 * This file is a SYMLINK into `.libs/vx-public/template/back/config/` in a project:
 * Node resolves symlinks, so under ts-node `__dirname` is the REAL location (inside
 * `.libs`), not `back/src/config`. Paths are therefore derived from the process
 * working directory (`back/`) when running TypeScript sources, and from the compiled
 * file location (`dist/config`, a real file emitted by tsc) when running the build.
 * The `src/` alias needs `tsconfig-paths/register` under ts-node (nest build rewrites it).
 */
const isTypeScriptRun = __filename.endsWith('.ts');
const backDir = isTypeScriptRun ? process.cwd() : join(__dirname, '..', '..'); // back/
const baseDir = isTypeScriptRun ? join(backDir, 'src') : join(__dirname, '..'); // src/ or dist/

export const dbContext: DbContext = {
  baseDir,
  certBaseDir: backDir, // base for DB_SSLROOTCERT
  migrationGlobs: [join(baseDir, 'migrations/*.{js,ts}')],
};

const AppDataSource = new DataSource(buildMainDataSourceOptions(dbContext));
export default AppDataSource;
