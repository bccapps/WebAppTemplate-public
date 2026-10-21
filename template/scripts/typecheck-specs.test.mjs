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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { crossStackLinks, generatedSpecConfig, readSpecConfig } from './typecheck-specs.mjs';

function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'tcs-'));
  for (const dir of ['back/src/modules/engine/core', 'front/src/modules/engine', 'front/.libs/vx-public/react/common', 'front/src/modules_shared']) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  symlinkSync(path.join(root, 'back/src/modules/engine/core'), path.join(root, 'front/src/modules/engine/core'));
  symlinkSync(path.join(root, 'front/.libs/vx-public/react/common'), path.join(root, 'front/src/modules_shared/common'));
  symlinkSync(path.join(root, 'nowhere'), path.join(root, 'front/src/dangling'));
  return root;
}

test('crossStackLinks: only the links into the other stack (library links and dangling links are ignored)', () => {
  const root = project();
  assert.deepEqual(crossStackLinks(path.join(root, 'front'), 'front'), ['src/modules/engine/core']);
  assert.deepEqual(crossStackLinks(path.join(root, 'back'), 'back'), []);
  assert.throws(() => crossStackLinks(path.join(root, 'front'), 'desktop'), /unknown stack/);
  rmSync(root, { recursive: true, force: true });
});

test('generated config: base include/exclude rebased on node_modules/.tmp, cross-stack links excluded', () => {
  const root = project();
  writeFileSync(
    path.join(root, 'front', 'tsconfig.spec.json'),
    '{\n  // comment\n  "extends": "./tsconfig.app.json",\n  "include": ["src"],\n  "exclude": ["src/sw.ts"]\n}\n',
  );
  const config = generatedSpecConfig(readSpecConfig(path.join(root, 'front')), ['src/modules/engine/core']);
  assert.deepEqual(config, {
    extends: '../../tsconfig.spec.json',
    include: ['../../src'],
    exclude: ['../../src/sw.ts', '../../src/modules/engine/core/**'],
  });
  rmSync(root, { recursive: true, force: true });
});
