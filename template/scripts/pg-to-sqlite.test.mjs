/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArgs, readEnvFile, sourceEnvironment } from './pg-to-sqlite.mjs';

test('parseArgs: options, defaults and unknown option', () => {
  const options = parseArgs(['--source-url', 'postgres://u@h/db', '--out', 'x.db', '--force', '--naive-tz', 'local']);
  assert.equal(options.sourceUrl, 'postgres://u@h/db');
  assert.equal(options.out, 'x.db');
  assert.equal(options.force, true);
  assert.equal(options.naiveTz, 'local');
  assert.equal(options.pgSchema, 'public');
  assert.equal(parseArgs([]).naiveTz, 'utc');
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
});

test('readEnvFile: quotes, inline comments and export prefix, no shell evaluation', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pg2sqlite-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, 'DB_HOST="db.example"  # prod\nexport DB_PORT=4702\nDB_PASSWORD=p#ss$(rm -rf /)\n# DB_USER=commented\nDB_USER=agenthub\n');
  const env = readEnvFile(file);
  assert.equal(env.DB_HOST, 'db.example');
  assert.equal(env.DB_PORT, '4702');
  assert.equal(env.DB_PASSWORD, 'p#ss$(rm -rf /)');
  assert.equal(env.DB_USER, 'agenthub');
});

test('sourceEnvironment: from an env file (ssl only when asked) or from a URL, and a clear error without a source', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pg2sqlite-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, 'DB_HOST=h\nDB_PORT=1\nDB_USER=u\nDB_PASSWORD=pw\nDB_NAME=n\nDB_SSLMODE=require\n');
  const fromFile = sourceEnvironment({ sourceEnv: file, sourceUrl: null });
  assert.deepEqual(fromFile, { PG_SOURCE_HOST: 'h', PG_SOURCE_PORT: '1', PG_SOURCE_USER: 'u', PG_SOURCE_PASSWORD: 'pw', PG_SOURCE_NAME: 'n', PG_SOURCE_SSL: '1' });
  writeFileSync(file, 'DB_HOST=h\nDB_USER=u\nDB_NAME=n\nDB_SSLMODE=disable\n');
  assert.equal(sourceEnvironment({ sourceEnv: file, sourceUrl: null }).PG_SOURCE_SSL, '0');
  assert.deepEqual(sourceEnvironment({ sourceEnv: null, sourceUrl: 'postgres://x' }), { PG_SOURCE_URL: 'postgres://x' });
  assert.throws(() => sourceEnvironment({ sourceEnv: null, sourceUrl: null }), /--source-env/);
});
