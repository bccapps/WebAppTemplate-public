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
import { test } from 'node:test';

import { fmt, hostOf, isLocalHost, listFlag, loadEnvFile, parseArgs, parseEnvFile, requireFromProject, slug } from './util.mjs';

test('parseArgs: flags, values, repeated keys and positionals', () => {
  const out = parseArgs(['run', '--tier', 'a', '--tier=b', '--apply', '--confirm', 'host']);
  assert.deepEqual(out._, ['run']);
  assert.deepEqual(out.flags, { tier: ['a', 'b'], apply: true, confirm: 'host' });
});

test('listFlag always returns an array', () => {
  assert.deepEqual(listFlag(undefined), []);
  assert.deepEqual(listFlag(true), []);
  assert.deepEqual(listFlag('a'), ['a']);
  assert.deepEqual(listFlag(['a', 'b']), ['a', 'b']);
});

test('parseEnvFile: comments, quotes, export', () => {
  const env = parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x\'\n\nbad line\nD=');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x', D: '' });
});

test('loadEnvFile does not override set variables and returns added keys', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lt-'));
  const file = path.join(dir, 'e.env');
  writeFileSync(file, 'A=file\nB=file\nC=');
  const env = { A: 'shell' };
  assert.deepEqual(loadEnvFile(file, env).sort(), ['B', 'C']);
  assert.equal(env.A, 'shell');
  assert.deepEqual(loadEnvFile(path.join(dir, 'missing'), env), []);
});

test('requireFromProject returns null for an unknown package', () => {
  assert.equal(requireFromProject(tmpdir(), 'definitely-not-installed-xyz'), null);
});

test('hostOf, isLocalHost, fmt, slug', () => {
  assert.equal(hostOf('https://api.example.com/api/v1'), 'api.example.com');
  assert.equal(hostOf('nope'), '');
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('example.com'), false);
  assert.equal(fmt(1.234, 2), '1.23');
  assert.equal(fmt(NaN), '–');
  assert.equal(slug('Home / Bootstrap!'), 'home_bootstrap');
});
