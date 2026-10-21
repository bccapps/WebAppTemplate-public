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
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildEnvExample, buildPackage, fragmentConflicts, writeEnvExample } from './build-package.mjs';

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

/** Project with a template .env.example, module manifests and an optional .env.example.local. */
function envSetup({ local } = {}) {
  const { root, back } = setup();
  const w = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  w('back/.libs/apptemplate/back/.env.example', ['# Header', 'A=1', '# @module user', 'JWT_SECRET=', '# @end', '# @module voice', 'VOICE=1', '# @end', ''].join('\n'));
  w('back/.libs/vx-public/nest/common/module.json', JSON.stringify({ id: 'common', title: 'Common', env: ['ADMIN_TOKEN'] }));
  w('back/.libs/vx-private/nest/user/module.json', JSON.stringify({ id: 'user', title: 'User', env: ['JWT_SECRET', 'TIERS_FILE'] }));
  w('back/.libs/vx-public/nest/voice/module.json', JSON.stringify({ id: 'voice', title: 'Voice' }));
  if (local) w('back/.env.example.local', local);
  return { root, back };
}

test('.env.example is generated: header, linked blocks only, manifest variables, then the local file', () => {
  const { root, back } = envSetup({ local: '# App note\nAPP_FLAG=1\n' });
  const text = buildEnvExample('back', back);
  assert.match(text, /^# GENERATED by build-package\.mjs/);
  assert.match(text, /JWT_SECRET=/);
  assert.doesNotMatch(text, /VOICE=1/, 'voice is not linked');
  assert.doesNotMatch(text, /@module|@end/);
  assert.match(text, /# --- Common \(module common\) ---\n# ADMIN_TOKEN=/);
  assert.match(text, /# TIERS_FILE=/);
  assert.equal((text.match(/JWT_SECRET/g) ?? []).length, 1, 'a variable of the template is not repeated');
  assert.match(text, /# Project-specific \(back\/\.env\.example\.local\)\n# =+\n# App note\nAPP_FLAG=1\n$/);
  rmSync(root, { recursive: true, force: true });
});

test('.env.example: no shared-modules.json or no template => null; a template symlink is replaced, never written through', () => {
  const { root, back } = envSetup();
  const templateFile = path.join(back, '.libs', 'apptemplate', 'back', '.env.example');
  const before = readFileSync(templateFile, 'utf8');
  symlinkSync(templateFile, path.join(back, '.env.example'));
  writeEnvExample('back', back);
  assert.equal(lstatSync(path.join(back, '.env.example')).isSymbolicLink(), false);
  assert.equal(readFileSync(templateFile, 'utf8'), before, 'the template file is untouched');
  rmSync(path.join(root, 'shared-modules.json'));
  assert.equal(buildEnvExample('back', back), null);
  rmSync(root, { recursive: true, force: true });
});
