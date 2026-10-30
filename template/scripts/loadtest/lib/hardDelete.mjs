/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Optional hard delete of the synthetic accounts, for projects that do not want ~N anonymized rows left in
 * their database. Generic: the tables referencing the user table are discovered from the foreign keys. Runs in
 * ONE transaction that is rolled back unless `apply` is true (default: dry run, row counts only). Postgres only.
 */

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

const FK_SQL = `
  SELECT c.conrelid::regclass::text AS child, quote_ident(a.attname) AS col
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype = 'f' AND c.confrelid = $1::regclass AND array_length(c.conkey, 1) = 1
  ORDER BY 1, 2`;

/** Statements to run, children first then the user rows. `children` = [{ child, col }] (already quoted). */
export function buildDeleteStatements(userTable, children) {
  const statements = children.map(({ child, col }) => ({ table: child, sql: `DELETE FROM ${child} WHERE ${col} = ANY($1::int[])` }));
  statements.push({ table: userTable, sql: `DELETE FROM ${userTable} WHERE id = ANY($1::int[])` });
  return statements;
}

/** Refuses to run unless every id is an account whose nickname carries the load-test prefix. */
export async function assertOnlyLoadTestUsers(client, { userTable, nicknameColumn, prefix }, ids) {
  const result = await client.query(
    `SELECT id FROM ${userTable} WHERE id = ANY($1::int[]) AND ${quoteIdent(nicknameColumn)} LIKE $2`,
    [ids, `${prefix}-%`],
  );
  const bad = ids.filter((id) => !result.rows.some((row) => row.id === id));
  if (bad.length) throw new Error(`Refusing to delete: ids ${bad.join(', ')} are missing or are not "${prefix}-*" accounts`);
}

export async function hardDeleteUsers(client, auth, ids, { apply = false } = {}) {
  const userTable = quoteIdent(auth.userTable);
  await assertOnlyLoadTestUsers(client, { ...auth, userTable }, ids);
  const children = (await client.query(FK_SQL, [userTable])).rows;
  const counts = [];
  await client.query('BEGIN');
  try {
    for (const { table, sql } of buildDeleteStatements(userTable, children)) {
      counts.push({ table, rows: (await client.query(sql, [ids])).rowCount });
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`Hard delete rolled back: ${error.message}`);
  }
  return { applied: apply, counts };
}
