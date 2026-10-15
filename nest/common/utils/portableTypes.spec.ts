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
import { Column, CreateDateColumn, DataSource, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { adaptColumnOptions, applyPortableColumnTypes, mapPostgresType, portableTypesTotals, rewriteSqlDefault } from './portableTypes';

// The SQLite driver is an optional dependency (projects that choose SQLite add it): the integration part is skipped without it.
const hasSqliteDriver = ((): boolean => {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();
const describeWithSqlite = hasSqliteDriver ? describe : describe.skip;

process.env.DB_PORTABLE_LOG = 'false';

describe('mapPostgresType', () => {
  it('maps Postgres-only types to types SQLite accepts', () => {
    expect(mapPostgresType('jsonb')).toBe('simple-json');
    expect(mapPostgresType('JSON')).toBe('simple-json');
    expect(mapPostgresType('timestamptz')).toBe('datetime');
    expect(mapPostgresType('timestamp with time zone')).toBe('datetime');
    expect(mapPostgresType('timestamp(3)')).toBe('datetime');
    expect(mapPostgresType('enum')).toBe('simple-enum');
    expect(mapPostgresType('bytea')).toBe('blob');
    expect(mapPostgresType('character varying')).toBe('varchar');
    expect(mapPostgresType('int8')).toBe('bigint');
    expect(mapPostgresType('citext')).toBe('varchar');
  });

  it('leaves portable types alone', () => {
    for (const type of ['varchar', 'text', 'int', 'integer', 'boolean', 'date', 'uuid', 'simple-json', 'datetime', 'decimal', 'float']) {
      expect(mapPostgresType(type)).toBeUndefined();
    }
    expect(mapPostgresType(String)).toBeUndefined();
    expect(mapPostgresType(undefined)).toBeUndefined();
  });
});

describe('rewriteSqlDefault', () => {
  it('rewrites time and uuid defaults', () => {
    expect(rewriteSqlDefault('now()')).toBe('CURRENT_TIMESTAMP');
    expect(rewriteSqlDefault('NOW()')).toBe('CURRENT_TIMESTAMP');
    expect(rewriteSqlDefault("timezone('utc', now())")).toBe('CURRENT_TIMESTAMP');
    expect(rewriteSqlDefault('CURRENT_TIMESTAMP(6)')).toBe('CURRENT_TIMESTAMP');
    expect(rewriteSqlDefault('gen_random_uuid()')).toMatch(/^\(lower\(hex\(randomblob/);
    expect(rewriteSqlDefault('uuid_generate_v4()')).toMatch(/^\(lower\(hex\(randomblob/);
  });

  it('strips Postgres casts and keeps literals', () => {
    expect(rewriteSqlDefault("'[]'::jsonb")).toBe("'[]'");
    expect(rewriteSqlDefault("'{}'::jsonb")).toBe("'{}'");
    expect(rewriteSqlDefault("'x'::character varying")).toBe("'x'");
    expect(rewriteSqlDefault("'{}'", true)).toBe("'[]'");
    expect(rewriteSqlDefault("ARRAY[]::text[]", true)).toBe("'[]'");
    expect(rewriteSqlDefault('0')).toBe('0');
    expect(rewriteSqlDefault('true')).toBe('true');
    expect(rewriteSqlDefault('1 + 1')).toBe('(1 + 1)');
  });
});

describe('adaptColumnOptions', () => {
  it('rewrites a Postgres column and reports the change; a second pass changes nothing', () => {
    const options = { type: 'jsonb', default: () => "'[]'::jsonb", nullable: false } as Record<string, unknown>;
    expect(adaptColumnOptions(options)).toBe(true);
    expect(options.type).toBe('simple-json');
    expect((options.default as () => string)()).toBe("'[]'");
    expect(adaptColumnOptions(options)).toBe(false);
  });

  it('turns an array column into JSON and drops datetime precision', () => {
    const arrayColumn = { type: 'varchar', array: true } as Record<string, unknown>;
    expect(adaptColumnOptions(arrayColumn)).toBe(true);
    expect(arrayColumn).toEqual({ type: 'simple-json' });
    const date = { type: 'timestamptz', precision: 3 } as Record<string, unknown>;
    adaptColumnOptions(date);
    expect(date).toEqual({ type: 'datetime' });
  });
});

describe('applyPortableColumnTypes', () => {
  it('is a no-op under Postgres', () => {
    const before = portableTypesTotals().columns;
    const report = applyPortableColumnTypes('postgres');
    expect(report.active).toBe(false);
    expect(report.columns).toBe(0);
    expect(portableTypesTotals().columns).toBe(before);
  });
});

describeWithSqlite('applyPortableColumnTypes on SQLite (entities written for Postgres, no helpers)', () => {
  // Declared BEFORE the call: adapted by the sweep.
  @Entity({ name: 'portable_before' })
  @Index('idx_portable_before_active', ['label'], { where: "label <> ''::text" })
  class BeforeEntity {
    @PrimaryGeneratedColumn('uuid') id!: string;
    @Column({ type: 'varchar', length: 64 }) label!: string;
    @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) payload!: Record<string, unknown>;
    @Column({ type: 'timestamptz', nullable: true, default: null }) seenAt!: Date | null;
    @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
    @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
  }

  let AfterEntity: new () => { id: string; tags: string[]; state: string; blob: Buffer; at: Date; big: string; count: number };
  let GeneratedBigEntity: new () => { id: number; label: string };
  let ds: DataSource;
  let report: ReturnType<typeof applyPortableColumnTypes>;

  beforeAll(async () => {
    report = applyPortableColumnTypes('sqlite');
    // Declared AFTER the call: adapted as the decorators register (TypeORM imports entity files after the options are built).
    @Entity({ name: 'portable_after' })
    @Index('uq_portable_after_state', ['state'], { unique: true, where: "state ~ '^[a-z]+$'" })
    class DeclaredAfter {
      @PrimaryGeneratedColumn('uuid') id!: string;
      @Column({ type: 'text', array: true, default: () => "'{}'" }) tags!: string[];
      @Column({ type: 'enum', enum: ['new', 'done'], default: 'new' }) state!: string;
      @Column({ type: 'bytea' }) blob!: Buffer;
      @Column({ type: 'timestamp with time zone', precision: 3, default: () => 'now()' }) at!: Date;
      @Column({ type: 'int8' }) big!: string;
      @Column({ type: 'int4', default: 0 }) count!: number;
    }
    AfterEntity = DeclaredAfter as unknown as typeof AfterEntity;
    @Entity({ name: 'portable_generated_big' })
    class DeclaredGeneratedBig {
      @PrimaryGeneratedColumn({ type: 'bigint' }) id!: number;
      @Column({ type: 'varchar', length: 16 }) label!: string;
    }
    GeneratedBigEntity = DeclaredGeneratedBig as unknown as typeof GeneratedBigEntity;
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [BeforeEntity, DeclaredAfter, DeclaredGeneratedBig], synchronize: true });
    await ds.initialize();
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  it('adapts what was already registered, is idempotent, and reports what it did', () => {
    expect(report.active).toBe(true);
    expect(report.columns).toBeGreaterThanOrEqual(5);
    expect(report.byType['simple-json']).toBeGreaterThanOrEqual(1);
    expect(applyPortableColumnTypes('sqlite').columns).toBe(0);
  });

  it('synchronises the schema and round-trips JSON, dates and defaults', async () => {
    const repo = ds.getRepository(BeforeEntity);
    const at = new Date('2026-03-04T05:06:07.000Z');
    const saved = await repo.save(repo.create({ label: 'a', payload: { n: 1, nested: { ok: true } }, seenAt: at }));
    const loaded = await repo.findOneOrFail({ where: { id: saved.id } });
    expect(loaded.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(loaded.payload).toEqual({ n: 1, nested: { ok: true } });
    expect(loaded.seenAt?.toISOString()).toBe(at.toISOString());
    expect(loaded.createdAt).toBeInstanceOf(Date);
    const defaulted = await repo.save(repo.create({ label: 'b' }));
    expect((await repo.findOneOrFail({ where: { id: defaulted.id } })).payload).toEqual({});
  });

  it('round-trips arrays, enums, bytea, bigint and a now() default declared after the call', async () => {
    const repo = ds.getRepository(AfterEntity);
    const saved = await repo.save(repo.create({ tags: ['x', 'y,z'], state: 'done', blob: Buffer.from([1, 2, 3]), big: '123456789012', count: 3 }));
    const loaded = await repo.findOneOrFail({ where: { id: saved.id } });
    expect(loaded.tags).toEqual(['x', 'y,z']);
    expect(loaded.state).toBe('done');
    expect(Buffer.from(loaded.blob)).toEqual(Buffer.from([1, 2, 3]));
    expect(String(loaded.big)).toBe('123456789012'); // beyond 2^53 SQLite integers lose precision (documented)
    expect(loaded.at).toBeInstanceOf(Date);
    const defaults = await repo.save(repo.create({ blob: Buffer.alloc(1), big: '1' }));
    const reloaded = await repo.findOneOrFail({ where: { id: defaults.id } });
    expect(reloaded.tags).toEqual([]);
    expect(reloaded.state).toBe('new');
    expect(Math.abs(reloaded.at.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('retypes a generated bigint primary key integer (AUTOINCREMENT needs it) and numbers the rows', async () => {
    const repo = ds.getRepository(GeneratedBigEntity);
    const first = await repo.save(repo.create({ label: 'a' }));
    const second = await repo.save(repo.create({ label: 'b' }));
    expect(Number(second.id)).toBe(Number(first.id) + 1);
  });

  it('drops a partial UNIQUE index it cannot express rather than over-constraining, keeps a plain partial one without its Postgres cast', async () => {
    expect(portableTypesTotals().droppedIndices).toContain('uq_portable_after_state');
    const repo = ds.getRepository(AfterEntity);
    // The unique index (state ~ regex) was dropped: two rows may share a state.
    await repo.save(repo.create({ state: 'new', blob: Buffer.alloc(1), big: '1' }));
    await repo.save(repo.create({ state: 'new', blob: Buffer.alloc(1), big: '2' }));
    const indexes = await ds.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_portable_before_active'");
    expect(indexes).toHaveLength(1);
  });
});
