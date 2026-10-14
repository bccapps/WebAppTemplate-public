/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Jest `globalSetup` of the SQLite run (test/jest-e2e-sqlite.json): every run starts from an empty database FILE under
// `back/.tmp/e2e-sqlite/` (never the dev database, never a user database).
import { mkdirSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';

export const SQLITE_E2E_DB_PATH = resolve(__dirname, '../.tmp/e2e-sqlite/app-test.db');

export default async function globalSetup(): Promise<void> {
  mkdirSync(dirname(SQLITE_E2E_DB_PATH), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${SQLITE_E2E_DB_PATH}${suffix}`, { force: true });
}
