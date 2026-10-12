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
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { mergeJestConfig, readLocalJest } from './merge-jest.mjs';

const shared = {
  rootDir: '/a/src',
  roots: ['<rootDir>', '/lib'],
  moduleNameMapper: { '^src/(.*)$': '<rootDir>/$1' },
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
};

test('no local config returns the shared one', () => {
  assert.deepEqual(mergeJestConfig(shared, undefined), shared);
});

test('moduleNameMapper is merged key by key', () => {
  const r = mergeJestConfig(shared, { moduleNameMapper: { '^@x/y$': '/z' } });
  assert.deepEqual(r.moduleNameMapper, { '^src/(.*)$': '<rootDir>/$1', '^@x/y$': '/z' });
});

test('transform entry with the same pattern is replaced by local', () => {
  const r = mergeJestConfig(shared, { transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] } });
  assert.deepEqual(r.transform, { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] });
});

test('arrays and scalars are replaced, shared input is not mutated', () => {
  const r = mergeJestConfig(shared, { roots: ['/only'], resolver: '/r.js' });
  assert.deepEqual(r.roots, ['/only']);
  assert.equal(r.resolver, '/r.js');
  assert.deepEqual(shared.roots, ['<rootDir>', '/lib']);
});

test('readLocalJest reads the jest key, tolerates absence', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mj-'));
  assert.equal(readLocalJest(dir), undefined);
  writeFileSync(path.join(dir, 'package.local.json'), JSON.stringify({ jest: { a: 1 } }));
  assert.deepEqual(readLocalJest(dir), { a: 1 });
});
