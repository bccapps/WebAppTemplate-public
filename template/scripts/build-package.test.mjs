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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildPackage, fragmentConflicts } from './build-package.mjs';

function setup({ withJestConfig = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'bp-'));
  const back = path.join(root, 'back');
  const w = (rel, obj) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  w('shared-modules.json', { nestcommon: ['common', 'user', 'nofrag'] });
  w('back/.libs/apptemplate/back/package.base.json', {
    private: true,
    scripts: { build: 'base' },
    dependencies: { a: '1', b: '1', c: '1' },
    overrides: { x: '1' },
    jest: { rootDir: 'src' },
  });
  w('back/.libs/vx-public/nest/common/package.fragment.json', { dependencies: { b: '2', d: '2' } });
  w('back/.libs/vx-private/nest/user/package.fragment.json', { dependencies: { b: '3', e: '3' }, overrides: { y: '1' } });
  w('back/.libs/vx-public/nest/nofrag/index.ts', '');
  w('back/package.local.json', { name: 'app', dependencies: { e: '4' } });
  if (withJestConfig) w('back/jest.config.js', 'module.exports = {}');
  return { root, back };
}

test('merges base, fragments in shared-modules order, then local (priority)', () => {
  const { root, back } = setup();
  const { pkg, fragments } = buildPackage('back', back);
  assert.deepEqual(fragments, ['common', 'user']);
  assert.deepEqual(pkg.dependencies, { a: '1', b: '3', c: '1', d: '2', e: '4' });
  assert.deepEqual(pkg.overrides, { x: '1', y: '1' });
  assert.equal(pkg.name, 'app');
  assert.deepEqual(pkg.jest, { rootDir: 'src' });
  rmSync(root, { recursive: true });
});

test('drops the jest key when jest.config.js exists', () => {
  const { root, back } = setup({ withJestConfig: true });
  assert.equal('jest' in buildPackage('back', back).pkg, false);
  rmSync(root, { recursive: true });
});

test('base absent => null; local absent => throws', () => {
  const { root, back } = setup();
  assert.equal(buildPackage('back', path.join(root, 'elsewhere')), null);
  rmSync(path.join(back, 'package.local.json'));
  assert.throws(() => buildPackage('back', back), /package\.local\.json/);
  rmSync(root, { recursive: true });
});

test('app module fragments merge after shared ones (sorted), before local; conflicts are reported', () => {
  const { root, back } = setup();
  const w = (rel, obj) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), JSON.stringify(obj));
  };
  w('back/src/modules/zeta/package.fragment.json', { dependencies: { f: '1', d: '9' } });
  w('back/src/modules/alpha/package.fragment.json', { dependencies: { g: '1' } });
  w('back/src/modules/none/index.ts', {});
  const { pkg, fragments, conflicts } = buildPackage('back', back);
  assert.deepEqual(fragments, ['common', 'user', 'app:alpha', 'app:zeta']);
  assert.deepEqual(pkg.dependencies, { a: '1', b: '3', c: '1', d: '9', e: '4', f: '1', g: '1' });
  assert.deepEqual(conflicts.map((c) => c.pkg).sort(), ['b', 'd']);
  rmSync(root, { recursive: true });
});

test('fragmentConflicts ignores identical specifiers', () => {
  const { root, back } = setup();
  const files = [
    { name: 'x', file: path.join(back, '.libs/vx-public/nest/common/package.fragment.json') },
    { name: 'y', file: path.join(back, '.libs/vx-public/nest/common/package.fragment.json') },
  ];
  assert.deepEqual(fragmentConflicts(files), []);
  rmSync(root, { recursive: true });
});
