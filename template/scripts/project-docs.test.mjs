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
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MARKER, ensure, renderAgentsMd, renderClaudeMd } from './project-docs.mjs';

const project = (withPrivate) => {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-'));
  mkdirSync(path.join(root, 'front/.libs/vx-public/template'), { recursive: true });
  writeFileSync(path.join(root, 'front/.libs/vx-public/template/CLAUDE.md'), '# Template rules\n');
  symlinkSync('vx-public/template', path.join(root, 'front/.libs/apptemplate'));
  if (withPrivate) {
    mkdirSync(path.join(root, 'front/.libs/vx-private'), { recursive: true });
    writeFileSync(path.join(root, 'front/.libs/vx-private/CLAUDE.private.md'), '# Private rules\n');
  }
  return root;
};

test('renderClaudeMd: fresh, marker preserved, legacy content kept below the marker', () => {
  const imp = ['@a'];
  assert.equal(renderClaudeMd(null, imp), `@a\n${MARKER}\n`);
  assert.equal(renderClaudeMd(`@old\n${MARKER}\nmy notes\n`, imp), `@a\n${MARKER}\nmy notes\n`);
  assert.equal(renderClaudeMd('legacy notes\n', imp), `@a\n${MARKER}\nlegacy notes\n`);
});

test('ensure: symlink CLAUDE.md/AGENTS.md replaced, private import only when mounted, idempotent, AGENTS inlines imports', () => {
  const root = project(true);
  symlinkSync('front/.libs/apptemplate/CLAUDE.md', path.join(root, 'CLAUDE.md'));
  symlinkSync('CLAUDE.md', path.join(root, 'AGENTS.md'));
  ensure(root);
  assert.equal(lstatSync(path.join(root, 'CLAUDE.md')).isSymbolicLink(), false);
  assert.equal(lstatSync(path.join(root, 'AGENTS.md')).isSymbolicLink(), false);
  const claude = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^@front\/\.libs\/apptemplate\/CLAUDE\.md\n@front\/\.libs\/vx-private\/CLAUDE\.private\.md\n/);
  writeFileSync(path.join(root, 'CLAUDE.md'), `${claude}note A\n`);
  assert.equal(ensure(root).claudeChanged, false);
  const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('# Template rules') && agents.includes('# Private rules') && agents.includes('note A'));
  assert.match(readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\/AGENTS\.md$/m);
  rmSync(path.join(root, 'front/.libs/vx-private'), { recursive: true });
  ensure(root);
  const without = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(without, /vx-private/);
  assert.match(without, /note A/);
  rmSync(root, { recursive: true, force: true });
});

test('renderAgentsMd flags a missing import', () => {
  assert.match(renderAgentsMd('@nope\nx', () => null), /missing import: nope/);
});
