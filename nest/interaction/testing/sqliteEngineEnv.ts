/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Test helper: forces the SQLite engine for the entity decorators evaluated after this import (the counterpart of
 * `common/testing/postgresEngineEnv.ts`). Import it FIRST, call `restoreEngineEnv()` in `afterAll`.
 */
const saved = { DB_ENGINE: process.env.DB_ENGINE };
process.env.DB_ENGINE = 'sqlite';

export function restoreEngineEnv(): void {
  if (saved.DB_ENGINE === undefined) delete process.env.DB_ENGINE;
  else process.env.DB_ENGINE = saved.DB_ENGINE;
}
