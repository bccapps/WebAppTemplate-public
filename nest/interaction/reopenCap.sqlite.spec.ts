/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Reopening a cancelled ticket and the critical notices' cap (`testing/interactionReopenCap.testkit.ts`) on SQLite in memory. Needs `better-sqlite3` (skipped otherwise). */
import { restoreEngineEnv } from './testing/sqliteEngineEnv';
import { afterAll, describe, it } from '@jest/globals';
import { describeInteractionReopenAndCap } from './testing/interactionReopenCap.testkit';

const hasSqliteDriver = ((): boolean => {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();

afterAll(restoreEngineEnv);

if (hasSqliteDriver) describeInteractionReopenAndCap('SQLite', { database: () => ({ type: 'sqlite' }) });
else
  describe.skip('interaction reopen and critical cap — SQLite (better-sqlite3 not installed)', () => {
    it('skipped', () => undefined);
  });
