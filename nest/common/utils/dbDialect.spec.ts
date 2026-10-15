/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import 'reflect-metadata';
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { dialect, dialectOf } from './dbDialect';
import { parseDbDate, parseDbDateOrNull, toNumber } from './dbDate';
import { isForeignKeyViolation, isNotNullViolation, isUniqueViolation } from './dbErrors';
import { jsonColumnType, timestampColumnType } from './dbEngine';

const hasSqliteDriver = ((): boolean => {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();
const describeWithSqlite = hasSqliteDriver ? describe : describe.skip;

describe('dialect (Postgres)', () => {
  const pg = dialect('main');
  it('is Postgres by default and produces Postgres SQL', () => {
    const previous = process.env.DB_ENGINE;
    delete process.env.DB_ENGINE;
    try {
      const d = dialect();
      expect(d.sqlite).toBe(false);
      expect(d.ilike('p.name', ':q')).toBe('p.name ILIKE :q');
      expect(d.monthBucket('e.at')).toBe("to_char(e.at, 'YYYY-MM')");
      expect(d.now()).toBe('now()');
      expect(d.jsonExtract('c.data', 'a.b')).toBe("((c.data)::jsonb #>> '{a,b}')");
      expect(d.jsonArrayContains('t.tags', ':tag')).toBe('((t.tags)::jsonb @> (:tag)::jsonb)');
      expect(d.forUpdate()).toBe(' FOR UPDATE');
    } finally {
      if (previous !== undefined) process.env.DB_ENGINE = previous;
    }
    expect(pg).toBeDefined();
  });

  it('rejects a JSON path that is not plain keys (no injection through the path)', () => {
    expect(() => dialectOf({ options: { type: 'postgres' } }).jsonExtract('c', "a'); DROP TABLE x;--")).toThrow('Invalid JSON path');
    expect(() => dialectOf({ options: { type: 'better-sqlite3' } }).jsonExtract('c', 'a b')).toThrow('Invalid JSON path');
  });
});

describe('portable column helpers keep their Postgres types', () => {
  it('jsonColumnType / timestampColumnType stay jsonb / timestamptz on Postgres', () => {
    expect(jsonColumnType('does-not-exist')).toBe('jsonb');
    expect(timestampColumnType('does-not-exist')).toBe('timestamptz');
  });
});

describe('runtime helpers', () => {
  it('parseDbDate reads a zone-less SQLite string as UTC', () => {
    expect(parseDbDate('2026-03-04 05:06:07.000').toISOString()).toBe('2026-03-04T05:06:07.000Z');
    expect(parseDbDate('2026-03-04T05:06:07Z').toISOString()).toBe('2026-03-04T05:06:07.000Z');
    const date = new Date();
    expect(parseDbDate(date)).toBe(date);
    expect(parseDbDateOrNull(null)).toBeNull();
    expect(parseDbDateOrNull('2026-03-04 05:06:07')?.toISOString()).toBe('2026-03-04T05:06:07.000Z');
  });

  it('toNumber normalises Postgres string aggregates and null', () => {
    expect(toNumber('42')).toBe(42);
    expect(toNumber(7)).toBe(7);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('')).toBe(0);
    expect(toNumber('abc')).toBe(0);
    expect(toNumber('12.5')).toBe(12.5);
  });

  it('recognises constraint violations of both engines', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ driverError: { code: 'SQLITE_CONSTRAINT_UNIQUE' } })).toBe(true);
    expect(isUniqueViolation({ driverError: { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' } })).toBe(true);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isForeignKeyViolation({ code: '23503' })).toBe(true);
    expect(isForeignKeyViolation({ driverError: { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' } })).toBe(true);
    expect(isNotNullViolation({ code: '23502' })).toBe(true);
    expect(isNotNullViolation({ driverError: { code: 'SQLITE_CONSTRAINT_NOTNULL' } })).toBe(true);
  });
});

describeWithSqlite('dialect on the real SQLite engine', () => {
  @Entity({ name: 'dialect_row' })
  class Row {
    @PrimaryGeneratedColumn('uuid') id!: string;
    @Column({ type: 'varchar' }) name!: string;
    @Column({ type: 'simple-json' }) tags!: string[];
    @Column({ type: 'simple-json' }) meta!: Record<string, unknown>;
    @Column({ type: 'datetime' }) at!: Date;
  }

  let ds: DataSource;
  beforeAll(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Row], synchronize: true });
    await ds.initialize();
    const repo = ds.getRepository(Row);
    await repo.save([
      repo.create({ name: 'Alpha Service', tags: ['ci', 'tests'], meta: { owner: { name: 'ann' }, n: 3 }, at: new Date('2026-03-04T05:06:07.000Z') }),
      repo.create({ name: 'beta', tags: ['docs'], meta: { owner: { name: 'bob' }, n: 4 }, at: new Date('2026-04-10T00:00:00.000Z') }),
    ]);
  });
  afterAll(async () => {
    await ds.destroy();
  });

  const sqlite = () => dialectOf(ds);
  const qb = () => ds.getRepository(Row).createQueryBuilder('r');

  it('detects the live driver', () => {
    expect(sqlite().sqlite).toBe(true);
  });

  it('ilike matches case-insensitively', async () => {
    const rows = await qb().where(sqlite().ilike('r.name', ':q'), { q: '%ALPHA%' }).getMany();
    expect(rows.map((r) => r.name)).toEqual(['Alpha Service']);
  });

  it('jsonArrayContains matches arrays holding every wanted element', async () => {
    const both = await qb().where(sqlite().jsonArrayContains('r.tags', ':t'), { t: JSON.stringify(['ci', 'tests']) }).getMany();
    expect(both.map((r) => r.name)).toEqual(['Alpha Service']);
    const none = await qb().where(sqlite().jsonArrayContains('r.tags', ':t'), { t: JSON.stringify(['ci', 'docs']) }).getMany();
    expect(none).toHaveLength(0);
    const single = await qb().where(sqlite().jsonArrayContains('r.tags', ':t'), { t: JSON.stringify(['docs']) }).getMany();
    expect(single.map((r) => r.name)).toEqual(['beta']);
  });

  it('jsonExtract reads a nested key', async () => {
    const rows = await qb().select('r.name', 'name').addSelect(sqlite().jsonExtract('r.meta', 'owner.name'), 'owner').orderBy('r.name').getRawMany();
    expect(rows.map((r: { owner: string }) => r.owner)).toEqual(['ann', 'bob']);
  });

  it('monthBucket / dayBucket / epochSeconds / castText group and convert dates', async () => {
    const months = await qb().select(sqlite().monthBucket('r.at'), 'm').groupBy('m').orderBy('m').getRawMany();
    expect(months.map((r: { m: string }) => r.m)).toEqual(['2026-03', '2026-04']);
    const day = await qb().select(sqlite().dayBucket('r.at'), 'd').orderBy('d').getRawMany();
    expect(day.map((r: { d: string }) => r.d)).toEqual(['2026-03-04', '2026-04-10']);
    const epoch = await qb().select(sqlite().epochSeconds('r.at'), 'e').orderBy('e').getRawMany();
    expect(Number(epoch[0].e)).toBe(Date.UTC(2026, 2, 4, 5, 6, 7) / 1000);
    const text = await qb().select(sqlite().castText('r.at'), 't').orderBy('t').getRawMany();
    expect(typeof text[0].t).toBe('string');
  });

  it('now() is a valid default/expression and lockForWrite is a no-op', async () => {
    const [{ n }] = await ds.query(`SELECT ${sqlite().now()} AS n`);
    expect(parseDbDate(n).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const builder = qb();
    expect(sqlite().lockForWrite(builder)).toBe(builder);
    expect(sqlite().forUpdate()).toBe('');
  });

  it('aggregates come back as numbers and MAX(date) as a zone-less string that parseDbDate fixes', async () => {
    const raw = await qb().select('COUNT(*)', 'c').addSelect('MAX(r.at)', 'last').getRawOne();
    expect(toNumber(raw.c)).toBe(2);
    expect(parseDbDate(raw.last).toISOString()).toBe('2026-04-10T00:00:00.000Z');
  });

  it('a unique violation is recognised through TypeORM\'s wrapper', async () => {
    await ds.query('CREATE UNIQUE INDEX uq_dialect_name ON dialect_row (name)');
    const repo = ds.getRepository(Row);
    let caught: unknown;
    try {
      await repo.save(repo.create({ name: 'beta', tags: [], meta: {}, at: new Date() }));
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught)).toBe(true);
  });
});
