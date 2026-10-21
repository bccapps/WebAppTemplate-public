/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// link-config.mjs: linking (unchanged behaviour) and the read-only `--check` mode run by deploy-full.sh.
// Run: node --test scripts/link-config.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = path.dirname(SCRIPTS_DIR);
const DOCKER_FILES = '--only=back/Dockerfile,back/.dockerignore,front/Dockerfile,front/nginx.conf';

/** Throw-away project whose `<stack>/.libs/apptemplate` point at this template. */
function makeProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'lc-'));
  for (const stack of ['back', 'front']) {
    mkdirSync(path.join(root, stack, '.libs'), { recursive: true });
    symlinkSync(TEMPLATE_ROOT, path.join(root, stack, '.libs', 'apptemplate'));
  }
  return root;
}

function run(root, ...args) {
  const res = spawnSync('node', [path.join(SCRIPTS_DIR, 'link-config.mjs'), ...args, root], { encoding: 'utf8' });
  return { status: res.status, out: res.stdout + res.stderr };
}

test('linking creates relative symlinks and --check then passes', () => {
  const root = makeProject();
  try {
    assert.equal(run(root).status, 0);
    assert.ok(lstatSync(path.join(root, 'back/Dockerfile')).isSymbolicLink());
    const r = run(root, '--check');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /conformes au template/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--check: a project copy or a foreign symlink fails (exit 1) and names the file', () => {
  const root = makeProject();
  try {
    run(root);
    rmSync(path.join(root, 'back/Dockerfile'));
    writeFileSync(path.join(root, 'back/Dockerfile'), 'FROM scratch\n');
    rmSync(path.join(root, 'front/nginx.conf'));
    writeFileSync(path.join(root, 'elsewhere.conf'), '');
    symlinkSync('../elsewhere.conf', path.join(root, 'front/nginx.conf'));
    const r = run(root, '--check', DOCKER_FILES);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /back\/Dockerfile: copie projet/);
    assert.match(r.out, /front\/nginx\.conf: lien qui ne pointe pas vers le template/);
    assert.match(r.out, /2 écart\(s\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--check --only ignores the other entries; missing targets are reported, not fatal', () => {
  const root = makeProject();
  try {
    run(root);
    rmSync(path.join(root, 'back/tsconfig.json'));
    writeFileSync(path.join(root, 'back/tsconfig.json'), '{}\n'); // a deviation outside the checked set
    rmSync(path.join(root, 'front/Dockerfile'));
    const r = run(root, '--check', DOCKER_FILES);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /front\/Dockerfile: absent/);
    assert.doesNotMatch(r.out, /tsconfig/);
    assert.equal(run(root, '--check').status, 1, 'the full check sees the tsconfig copy');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--check never modifies the project', () => {
  const root = makeProject();
  try {
    const r = run(root, '--check', DOCKER_FILES);
    assert.equal(r.status, 0, r.out);
    assert.throws(() => lstatSync(path.join(root, 'back/Dockerfile')), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
