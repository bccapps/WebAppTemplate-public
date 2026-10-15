/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Test helper: forces the Postgres engine for the entity decorators evaluated after this import, whatever the
 * project's `.env` says (a SQLite project sets `DB_ENGINE=sqlite`). Import it before the entities and call
 * `restoreEngineEnv()` in `afterAll`, since `process.env` is shared by the test files of a worker.
 */
const saved = { DB_ENGINE: process.env.DB_ENGINE };
process.env.DB_ENGINE = 'postgres';

export function restoreEngineEnv(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
