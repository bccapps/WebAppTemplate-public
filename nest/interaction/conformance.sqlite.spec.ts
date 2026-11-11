/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * The conformance suite (04 §17) on SQLite: in memory, and on a temporary file for the « restart » tests. Needs
 * `better-sqlite3` (skipped otherwise, like the other SQLite specs of vx-public).
 */
import { restoreEngineEnv } from './testing/sqliteEngineEnv';
import { afterAll, describe, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describeInteractionConformance } from './testing/interactionConformance.testkit';

const hasSqliteDriver = ((): boolean => {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), 'interaction-conformance-'));
let files = 0;

afterAll(() => {
  restoreEngineEnv();
  rmSync(dir, { recursive: true, force: true });
});

if (hasSqliteDriver) {
  describeInteractionConformance('SQLite', {
    database: (purpose) => (purpose === 'fresh' ? { type: 'sqlite' } : { type: 'sqlite', file: join(dir, `db-${(files += 1)}.sqlite`) }),
  });
} else {
  describe.skip('interaction conformance — SQLite (better-sqlite3 not installed)', () => {
    it('skipped', () => undefined);
  });
}
