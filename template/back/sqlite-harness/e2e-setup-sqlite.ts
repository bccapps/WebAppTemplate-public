/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Environment of the SQLite run: the dev env for everything that is not the database, then the engine forced to SQLite (a dedicated
// file, schema from `synchronize`, no migrations). Entity decorators read the engine at import time, so this runs in `setupFiles`.
import { config } from 'dotenv';
import { resolve } from 'path';
import { SQLITE_E2E_DB_PATH } from './e2e-global-setup-sqlite';

config({ path: resolve(__dirname, '../.env.dev') });

process.env.DB_ENGINE = 'sqlite';
process.env.DB_PATH = SQLITE_E2E_DB_PATH;
process.env.DB_SCHEMA_MODE = 'sync';
delete process.env.TYPEORM_SYNC;
delete process.env.DB_MIGRATIONS_RUN;
