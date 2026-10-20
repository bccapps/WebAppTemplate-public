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
import { hasModule, libRoots, linkedModuleDirs, readSharedModules, resolveModule } from './lib-roots.mjs';

function project(dirs, shared) {
  const root = mkdtempSync(path.join(tmpdir(), 'lr-'));
  for (const d of dirs) mkdirSync(path.join(root, d), { recursive: true });
  if (shared) writeFileSync(path.join(root, 'shared-modules.json'), JSON.stringify(shared));
  return root;
}

test('legacy layout', () => {
  const root = project(['back/.libs/nestcommon/common', 'front/.libs/reactcommon/common']);
  assert.deepEqual(libRoots('back', path.join(root, 'back')).map((r) => r.name), ['legacy']);
  assert.equal(resolveModule('back', path.join(root, 'back'), 'common').origin, 'legacy');
  assert.equal(resolveModule('front', path.join(root, 'front'), 'common').origin, 'legacy');
  rmSync(root, { recursive: true });
});

test('new layout resolves public then private; missing module is null', () => {
  const root = project(['back/.libs/vx-public/nest/common', 'back/.libs/vx-private/nest/user']);
  const back = path.join(root, 'back');
  assert.deepEqual(libRoots('back', back).map((r) => r.name), ['vx-public', 'vx-private']);
  assert.equal(resolveModule('back', back, 'common').origin, 'vx-public');
  assert.equal(resolveModule('back', back, 'user').origin, 'vx-private');
  assert.equal(resolveModule('back', back, 'nope'), null);
  assert.deepEqual(libRoots('front', path.join(root, 'front')), []);
  rmSync(root, { recursive: true });
});

test('mixed layout: legacy used for modules absent from vx-*; duplicate public+private throws', () => {
  const root = project([
    'back/.libs/vx-public/nest/common', 'back/.libs/nestcommon/trading',
    'back/.libs/vx-public/nest/dup', 'back/.libs/vx-private/nest/dup',
  ]);
  const back = path.join(root, 'back');
  assert.equal(resolveModule('back', back, 'trading').origin, 'legacy');
  assert.throws(() => resolveModule('back', back, 'dup'), /both vx-public and vx-private/);
  rmSync(root, { recursive: true });
});

test('readSharedModules / hasModule', () => {
  const root = project([], { nestcommon: ['common', 'user'], reactcommon: ['common'] });
  assert.deepEqual(readSharedModules(root, 'back'), ['common', 'user']);
  assert.deepEqual(readSharedModules(root, 'front'), ['common']);
  assert.equal(hasModule(root, 'back', 'user'), true);
  assert.equal(hasModule(root, 'front', 'user'), false);
  const problems = [];
  assert.equal(readSharedModules(path.join(root, 'none'), 'back', (r) => problems.push(r)), null);
  assert.equal(problems.length, 1);
  rmSync(root, { recursive: true });
});

test('linkedModuleDirs: only the linked modules, every library root without shared-modules.json', () => {
  const dirs = ['back/.libs/vx-public/nest/common', 'back/.libs/vx-private/nest/user', 'back/.libs/vx-private/nest/unused'];
  const root = project(dirs, { nestcommon: ['common', 'user', 'absent'] });
  const back = path.join(root, 'back');
  assert.deepEqual(linkedModuleDirs('back', back), [path.join(back, '.libs/vx-public/nest/common'), path.join(back, '.libs/vx-private/nest/user')]);
  rmSync(path.join(root, 'shared-modules.json'));
  assert.deepEqual(linkedModuleDirs('back', back), [path.join(back, '.libs/vx-public/nest'), path.join(back, '.libs/vx-private/nest')]);
  rmSync(root, { recursive: true });
});
