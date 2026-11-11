/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * The conformance suite (04 §17) on Postgres, plus the hardening suite (`interactionHardening.testkit.ts`) and the concurrency variants (`interactionConcurrency.testkit.ts`). Runs only when `INTERACTION_TEST_PG_URL` names a THROWAWAY database
 * (`postgres://user:pass@127.0.0.1:55432/db`): every test gets its own schema, dropped at the end. Skipped otherwise.
 */
import { restoreEngineEnv } from '../common/testing/postgresEngineEnv';
import { afterAll, describe, it } from '@jest/globals';
import { randomBytes } from 'crypto';
import { describeInteractionConcurrency } from './testing/interactionConcurrency.testkit';
import { describeInteractionConformance } from './testing/interactionConformance.testkit';
import { describeInteractionHardening } from './testing/interactionHardening.testkit';
import { describeInteractionGate } from './testing/interactionGate.testkit';
import { describeInteractionReview } from './testing/interactionReview.testkit';

const url = process.env.INTERACTION_TEST_PG_URL;
const schemas: string[] = [];

afterAll(async () => {
  restoreEngineEnv();
  if (!url || schemas.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('pg') as typeof import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  for (const schema of schemas) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
});

if (url) {
  const database = (): { type: 'postgres'; url: string; schema: string } => {
    const schema = `ix_${randomBytes(6).toString('hex')}`;
    schemas.push(schema);
    return { type: 'postgres', url, schema };
  };
  describeInteractionConformance('Postgres', { database });
  // The hardening suite of lot C1 (proof capability, proof consumed by the winner, first writes, no secret anywhere).
  describeInteractionHardening('Postgres', { database });
  // The findings of the independent review (F1-F9), each exploit turned into a regression test.
  describeInteractionReview('Postgres', { database });
  // C2: answer gates (an answer applied by the app, atomic with the ticket).
  describeInteractionGate('Postgres', { database });
  // Races a single SQLite connection hides: a pool of connections, every contender launched at once.
  describeInteractionConcurrency('Postgres', { database });
} else {
  describe.skip('interaction conformance — Postgres (INTERACTION_TEST_PG_URL not set)', () => {
    it('skipped', () => undefined);
  });
}
