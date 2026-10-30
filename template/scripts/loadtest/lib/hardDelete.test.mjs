/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertOnlyLoadTestUsers, buildDeleteStatements, hardDeleteUsers } from './hardDelete.mjs';

const auth = { userTable: 'user', nicknameColumn: 'nickname', prefix: 'lt' };

function fakeDb({ ownedIds = [1, 2], failOn } = {}) {
  const log = [];
  return {
    log,
    query: async (sql, params) => {
      log.push(sql.split('\n')[0].trim().slice(0, 40));
      if (sql.includes('LIKE')) return { rows: ownedIds.map((id) => ({ id })) };
      if (sql.includes('pg_constraint')) return { rows: [{ child: 'user_tiers', col: 'user_id' }, { child: '"userconnection"', col: 'user_id' }] };
      if (failOn && sql.includes(failOn)) throw new Error('fk violation');
      return { rowCount: sql.startsWith('DELETE') ? params[0].length : 0, rows: [] };
    },
  };
}

test('buildDeleteStatements puts the user table last', () => {
  const statements = buildDeleteStatements('"user"', [{ child: 'user_tiers', col: 'user_id' }]);
  assert.deepEqual(statements.map((s) => s.table), ['user_tiers', '"user"']);
  assert.match(statements[1].sql, /^DELETE FROM "user" WHERE id = ANY\(\$1::int\[\]\)$/);
});

test('assertOnlyLoadTestUsers refuses ids that are not prefixed accounts', async () => {
  await assertOnlyLoadTestUsers(fakeDb(), { ...auth, userTable: '"user"' }, [1, 2]);
  await assert.rejects(assertOnlyLoadTestUsers(fakeDb({ ownedIds: [1] }), { ...auth, userTable: '"user"' }, [1, 2]), /ids 2 are missing/);
});

test('hardDeleteUsers: dry run rolls back, apply commits', async () => {
  const dry = fakeDb();
  const out = await hardDeleteUsers(dry, auth, [1, 2]);
  assert.equal(out.applied, false);
  assert.deepEqual(out.counts.map((c) => c.table), ['user_tiers', '"userconnection"', '"user"']);
  assert.ok(dry.log.includes('ROLLBACK') && !dry.log.includes('COMMIT'));
  const real = fakeDb();
  assert.equal((await hardDeleteUsers(real, auth, [1, 2], { apply: true })).applied, true);
  assert.ok(real.log.includes('COMMIT'));
});

test('hardDeleteUsers rolls back and reports a failing statement', async () => {
  const db = fakeDb({ failOn: 'DELETE FROM user_tiers' });
  await assert.rejects(hardDeleteUsers(db, auth, [1, 2], { apply: true }), /rolled back: fk violation/);
  assert.ok(db.log.includes('ROLLBACK') && !db.log.includes('COMMIT'));
});
