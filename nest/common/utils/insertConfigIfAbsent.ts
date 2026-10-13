/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Repository } from 'typeorm';
import ConfigurationEntity from '../entities/ConfigurationEntity';

export type ConfigSeedRow = Pick<ConfigurationEntity, 'name' | 'value' | 'description'>;

/**
 * Inserts the configuration rows whose `name` is not stored yet; existing rows are never touched.
 *
 * The insert is a single statement made idempotent by the engine (`ON CONFLICT DO NOTHING` on Postgres,
 * `INSERT OR IGNORE` on SQLite, through TypeORM `orIgnore()`), so two seeders running at the same time
 * (app defaults on bootstrap, module schemas during module init) cannot raise `UNIQUE constraint failed:
 * config.name` the way a read-then-insert does. Duplicate names inside `rows` keep the first one.
 *
 * @returns the number of rows actually inserted
 */
export async function insertConfigIfAbsent(repo: Repository<ConfigurationEntity>, rows: ConfigSeedRow[]): Promise<number> {
  const unique = [...new Map([...rows].reverse().map((row) => [row.name, row] as const)).values()].reverse();
  if (unique.length === 0) return 0;
  const before = await repo.count();
  await repo.createQueryBuilder().insert().into(ConfigurationEntity).values(unique).orIgnore().execute();
  return (await repo.count()) - before;
}
