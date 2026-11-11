/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** The answer gates suite (`testing/interactionGate.testkit.ts`, C2) on SQLite in memory. Needs `better-sqlite3` (skipped otherwise). */
import { restoreEngineEnv } from './testing/sqliteEngineEnv';
import { afterAll, describe, it } from '@jest/globals';
import { describeInteractionGate } from './testing/interactionGate.testkit';

const hasSqliteDriver = ((): boolean => {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();

afterAll(restoreEngineEnv);

if (hasSqliteDriver) describeInteractionGate('SQLite', { database: () => ({ type: 'sqlite' }) });
else
  describe.skip('interaction answer gates — SQLite (better-sqlite3 not installed)', () => {
    it('skipped', () => undefined);
  });
