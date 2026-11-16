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

import { MARKER, ensure, renderAgentsMd, renderClaudeMd, withRequiredGitignore } from './project-docs.mjs';

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

test('ensure: replaces symlinks, preserves notes and keeps a stable AGENTS pointer as sources change', () => {
  const root = project(true);
  symlinkSync('front/.libs/apptemplate/CLAUDE.md', path.join(root, 'CLAUDE.md'));
  symlinkSync('CLAUDE.md', path.join(root, 'AGENTS.md'));
  ensure(root);
  assert.equal(lstatSync(path.join(root, 'CLAUDE.md')).isSymbolicLink(), false);
  assert.equal(lstatSync(path.join(root, 'AGENTS.md')).isSymbolicLink(), false);
  const claude = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^@front\/\.libs\/apptemplate\/CLAUDE\.md\n@front\/\.libs\/vx-private\/CLAUDE\.private\.md\n/);
  const initialAgents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  writeFileSync(path.join(root, 'CLAUDE.md'), `${claude}note A\n`);
  assert.equal(ensure(root).claudeChanged, false);
  const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.equal(agents, initialAgents);
  assert.doesNotMatch(agents, /# Template rules|# Private rules|note A/);
  assert.match(readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\/AGENTS\.md$/m);
  rmSync(path.join(root, 'front/.libs/vx-private'), { recursive: true });
  ensure(root);
  const without = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(without, /vx-private/);
  assert.match(without, /note A/);
  assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), initialAgents);
  rmSync(root, { recursive: true, force: true });
});

test('renderAgentsMd instructs agents to read CLAUDE.md and recursively resolve imports relative to their source', () => {
  const agents = renderAgentsMd();
  assert.match(agents, /read CLAUDE\.md at the project root in full and follow its instructions/);
  assert.match(agents, /Recursively read every file referenced by an @path import line/);
  assert.match(agents, /relative to the directory of the file containing it/);
});

test('withRequiredGitignore appends logs/, .validation-cache/ and /AGENTS.md once, never rewrites the rest', () => {
  const out = withRequiredGitignore('node_modules\n.env*\n');
  assert.match(out, /^node_modules\n\.env\*\n/);
  for (const line of ['/AGENTS.md', 'logs/', '.validation-cache/']) assert.equal(out.split('\n').filter((l) => l === line).length, 1);
  assert.equal(withRequiredGitignore(out), out);
  const legacy = 'logs\n/AGENTS.md\n.validation-cache\n';
  assert.equal(withRequiredGitignore(legacy), legacy);
});
