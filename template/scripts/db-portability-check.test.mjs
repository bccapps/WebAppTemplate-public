/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moduleDatabases, scanText, scanTree, summarize } from './lib/db-portability.mjs';
import { main, parseArgs } from './db-portability-check.mjs';

const rules = (text, options) => scanText(text, options).findings.map((finding) => `${finding.rule}:${finding.severity}`);

test('flags Postgres-only SQL written in strings', () => {
  assert.deepEqual(rules("qb.where('p.name ILIKE :q')"), ['ILIKE:error']);
  assert.deepEqual(rules("qb.where('t.tags::jsonb @> :tag::jsonb')"), ['pg-cast:error', 'jsonb-contains:error']);
  assert.deepEqual(rules("qb.select(\"to_char(e.at, 'YYYY-MM')\")"), ['to_char:error']);
  assert.deepEqual(rules("qb.where('e.at > NOW() - INTERVAL \\'1 day\\'')").sort(), ['interval:error', 'now:error']);
  assert.deepEqual(rules("await ds.query('SELECT * FROM t FOR UPDATE')"), ['for-update:error']);
  assert.deepEqual(rules("qb.where('id = ANY(:ids)')"), ['any-array:error']);
});

test('flags Postgres-only QueryBuilder methods in code', () => {
  assert.deepEqual(rules('const r = await qb.insert().returning("id").execute();'), ['returning-qb:error']);
  assert.deepEqual(rules("qb.setLock('pessimistic_write');"), ['set-lock:error']);
});

test('ignores comments, documentation strings, Date.now() and IPv6-looking text', () => {
  assert.deepEqual(rules('// ILIKE is Postgres only'), []);
  assert.deepEqual(rules(' * uses ILIKE'), []);
  assert.deepEqual(rules("  description: 'filters with ILIKE on text',"), []);
  assert.deepEqual(rules('const ref = `revert-${Date.now()}`;'), []);
  assert.deepEqual(rules("const loopback = '::ffff:127.0.0.1';"), []);
  assert.deepEqual(rules("const lower = 'x'.toLowerCase(); // TypeORM ILike() operator is portable"), []);
  assert.deepEqual(rules('/*\n ILIKE in a block comment\n*/\nconst a = 1;'), []);
});

test('an exemption needs a reason, on the same line or the line above', () => {
  assert.deepEqual(rules("qb.where('p.name ILIKE :q'); // pg-only: admin tool, Postgres hub only"), []);
  assert.deepEqual(rules("// pg-only: guarded by the engine check\nqb.where('p.name ILIKE :q');"), []);
  const bare = rules("qb.where('p.name ILIKE :q'); // pg-only:");
  assert.equal(bare.length, 1);
  assert.match(bare[0], /needs a reason/);
});

test('Postgres column types in entities are adapted automatically: counted, never errors; casts/now() in defaults are notes', () => {
  const entity = [
    "@Column({ type: 'jsonb', default: () => \"'{}'::jsonb\" }) a;",
    "@Column({ type: 'timestamptz', default: () => 'now()' }) b;",
    "@Column({ type: 'enum', enum: ['x'] }) c;",
    "@Column({ type: 'text', array: true }) d;",
  ].join('\n');
  const { findings, entityTypes } = scanText(entity, { isEntity: true });
  assert.deepEqual(entityTypes, { 'entity-jsonb': 1, 'entity-timestamptz': 1, 'entity-enum': 1, 'entity-array': 1 });
  assert.ok(findings.length > 0 && findings.every((finding) => finding.severity === 'note'));
  assert.equal(summarize(findings).errors, 0);
});

test('scanTree skips tests, migrations, node_modules and symlinked shared modules', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vx-dbcheck-'));
  try {
    const write = (relative, text) => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), text);
    };
    write('src/modules/a/service.ts', "qb.where('x ILIKE :q');\n");
    write('src/modules/a/service.spec.ts', "qb.where('x ILIKE :q');\n");
    write('src/migrations/1-x.ts', "q.query('ALTER ... ::jsonb');\n");
    write('src/modules/a/node_modules/dep.ts', "q.where('x ILIKE :q');\n");
    write('shared/b/service.ts', "qb.where('y ILIKE :q');\n");
    symlinkSync(path.join(root, 'shared/b'), path.join(root, 'src/modules_shared_b'));
    const result = scanTree(root);
    assert.equal(result.files, 1);
    assert.deepEqual(result.findings.map((finding) => finding.file), ['src/modules/a/service.ts']);
    assert.equal(scanTree(root, { followShared: true }).findings.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('moduleDatabases reads module.json', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vx-dbcheck-'));
  try {
    writeFileSync(path.join(root, 'module.json'), JSON.stringify({ databases: ['Postgres'] }));
    assert.deepEqual(moduleDatabases(root), ['postgres']);
    writeFileSync(path.join(root, 'module.json'), JSON.stringify({ name: 'x' }));
    assert.equal(moduleDatabases(root), null);
    assert.equal(moduleDatabases(path.join(root, 'nope')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--json', '--static-only']), { root: process.cwd(), json: true, staticOnly: true, schemaOnly: false, includePostgresOnly: false, includeShared: false });
  assert.equal(parseArgs(['--root', '/tmp/x']).root, '/tmp/x');
  assert.throws(() => parseArgs(['--static-only', '--schema-only']), /exclusive/);
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
});

test('main --static-only exits 1 on a finding, 0 once exempted (--json output)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vx-dbcheck-'));
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(line);
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src/a.ts'), "qb.where('x ILIKE :q');\n");
    assert.equal(await main(['--root', root, '--static-only', '--json']), 1);
    assert.equal(JSON.parse(logs.pop()).ok, false);
    writeFileSync(path.join(root, 'src/a.ts'), "qb.where('x ILIKE :q'); // pg-only: tested on Postgres only\n");
    assert.equal(await main(['--root', root, '--static-only', '--json']), 0);
    assert.equal(JSON.parse(logs.pop()).ok, true);
    await assert.rejects(main(['--root', path.join(root, 'missing'), '--static-only']), /No src\/ directory/);
  } finally {
    console.log = original;
    rmSync(root, { recursive: true, force: true });
  }
});

// Schema check on a toy project. It needs typeorm, better-sqlite3 and ts-node: point VX_DBCHECK_NODE_MODULES at a back node_modules to run it.
const nodeModules = process.env.VX_DBCHECK_NODE_MODULES;
test('schema check lists an untranslatable column and passes once it is portable', { skip: !nodeModules || !existsSync(path.join(nodeModules, '..', '.libs/vx-public/nest/common/utils/portableTypes.ts')) }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vx-dbcheck-'));
  const original = console.log;
  const logs = [];
  console.log = (line) => logs.push(line);
  try {
    mkdirSync(path.join(root, 'src/modules/demo/entities'), { recursive: true });
    symlinkSync(nodeModules, path.join(root, 'node_modules'));
    // The automatic adaptation of the framework (what an app gets through `modules_shared/common`).
    const utils = path.join(nodeModules, '..', '.libs/vx-public/nest/common/utils');
    mkdirSync(path.join(root, '.libs/vx-public/nest/common/utils'), { recursive: true });
    for (const file of ['portableTypes.ts', 'dbEngine.ts']) symlinkSync(path.join(utils, file), path.join(root, '.libs/vx-public/nest/common/utils', file));
    writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', experimentalDecorators: true, emitDecoratorMetadata: true, strict: false, esModuleInterop: true } }));
    const entity = (type) =>
      `import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';\n@Entity({ name: 'demo' })\nexport class DemoEntity {\n  @PrimaryGeneratedColumn('uuid') id: string;\n  @Column({ type: 'jsonb', nullable: true }) data: unknown;\n  @Column({ type: '${type}', nullable: true }) range: string;\n}\n`;
    writeFileSync(path.join(root, 'src/modules/demo/entities/DemoEntity.ts'), entity('tsrange'));
    assert.equal(await main(['--root', root, '--schema-only', '--json']), 1);
    const failed = JSON.parse(logs.pop());
    assert.equal(failed.schema.entities, 1);
    assert.equal(failed.schema.failures[0].column, 'range');
    assert.equal(failed.schema.failures[0].type, 'tsrange');
    writeFileSync(path.join(root, 'src/modules/demo/entities/DemoEntity.ts'), entity('varchar'));
    assert.equal(await main(['--root', root, '--schema-only', '--json']), 0);
    assert.equal(JSON.parse(logs.pop()).schema.failures.length, 0);
  } finally {
    console.log = original;
    rmSync(root, { recursive: true, force: true });
  }
});
