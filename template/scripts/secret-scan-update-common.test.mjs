/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// End-to-end tests of the secret scanning step of update_common.sh (--pull-only), with REAL git (and gitleaks when
// installed) in throwaway projects whose libraries are local clones of a fake vx-public holding the real scripts:
// first run (config + workflow committed, hooks installed), idempotent second run, a registry change reaching the
// project through the installed hook, a project that ignores its CLAUDE.md, a hand-written .gitleaks.toml and a project
// hook kept, no gitleaks on the PATH (hooks not installed; an update_common commit refused is reported, not ignored).
//
// Run: node --test scripts/secret-scan-update-common.test.mjs   (needs bash, git, node; gitleaks for most cases)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { git, put, sandbox } from './lib/secret-scan-testkit.mjs';
import { HOOK_MARKER, gitleaksStatus } from './secret-scan.mjs';

const REPO = path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), '../..');
const LIB_FILES = [
  'template/scripts/update_common.sh', 'template/scripts/project-docs.mjs', 'template/scripts/lib/git-paths.sh',
  'template/scripts/secret-scan.mjs', 'template/scripts/gitleaks-config.mjs', 'template/scripts/lib/secret-formats.mjs',
  'template/scripts/git-hooks/vx-secret-scan.sh', 'template/.github/workflows/secret-scan.yml', 'nest/common/validation/secret-formats.json',
];
const NO_TOOLS = ['bash', 'git'].some((t) => spawnSync(t, ['--version']).error) ? 'bash or git not installed' : false;
const NO_GITLEAKS = NO_TOOLS || (gitleaksStatus().ok ? false : 'gitleaks >= 8.30 not installed');

/** Fake vx-public (bare origin + work clone) holding the real scripts, and a project mounting it twice. */
function project(sb, { claude = 'tracked', files = {}, gitlinks = false } = {}) {
  const lib = path.join(sb.base, 'lib-work');
  for (const rel of LIB_FILES) {
    mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true });
    copyFileSync(path.join(REPO, rel), path.join(lib, rel));
  }
  put(lib, 'template/CLAUDE.md', '# Template rules\n');
  git(lib, sb.env, 'init', '-q');
  git(lib, sb.env, 'add', '-A');
  git(lib, sb.env, 'commit', '-q', '-m', 'lib');
  const origin = path.join(sb.base, 'origin.git');
  git(sb.base, sb.env, 'clone', '-q', '--bare', lib, origin);
  git(lib, sb.env, 'remote', 'add', 'origin', origin);

  const root = path.join(sb.base, 'app');
  mkdirSync(root);
  git(root, sb.env, 'init', '-q');
  put(root, '.gitmodules', '[submodule "back/.libs/vx-public"]\n\tpath = back/.libs/vx-public\n\turl = x\n[submodule "front/.libs/vx-public"]\n\tpath = front/.libs/vx-public\n\turl = x\n');
  for (const stack of ['back', 'front']) {
    mkdirSync(path.join(root, stack, '.libs'), { recursive: true });
    git(root, sb.env, 'clone', '-q', origin, path.join(root, stack, '.libs/vx-public'));
    symlinkSync('vx-public/template', path.join(root, stack, '.libs/apptemplate'));
  }
  symlinkSync('front/.libs/apptemplate/scripts', path.join(root, 'scripts'));
  // Plain clones kept out of the index, or recorded as gitlinks like real submodules (what the refs bump commits).
  if (!gitlinks) writeFileSync(path.join(root, '.git/info/exclude'), 'back/.libs/vx-public/\nfront/.libs/vx-public/\n');
  put(root, '.gitignore', claude === 'ignored' ? '/CLAUDE.md\n' : 'node_modules/\n');
  if (claude === 'tracked') put(root, 'CLAUDE.md', 'my project notes\n');
  for (const [rel, content] of Object.entries(files)) put(root, rel, content);
  git(root, sb.env, 'add', '-A');
  git(root, sb.env, 'commit', '-q', '-m', 'init');
  return { root, lib };
}

/** `mode`: '--pull-only' (default), or 'push' for the normal sync (commit, rebase, push, refs bump). */
const updateCommon = (root, env, mode = '--pull-only') => spawnSync('bash', [path.join(root, 'scripts/update_common.sh'), ...(mode === 'push' ? [] : [mode])], { cwd: root, env, encoding: 'utf8' });
const head = (sb, root) => git(root, sb.env, 'rev-parse', 'HEAD');
const subjects = (sb, root) => git(root, sb.env, 'log', '--format=%s').split('\n');
const filesOf = (sb, root, rev = 'HEAD') => git(root, sb.env, 'show', '--name-only', '--format=', rev).split('\n').filter(Boolean).sort();
const hook = (root, name) => path.join(root, '.git/hooks', name);

/** Adds a format to the fake library's registry and pushes it (what a vx-public change looks like to the project). */
function publishRegistryChange(sb, lib) {
  const file = path.join(lib, 'nest/common/validation/secret-formats.json');
  const registry = JSON.parse(readFileSync(file, 'utf8'));
  registry.formats.push({ ...registry.formats.find((f) => f.prefix === 'mst_'), id: 'zz-test-format', prefix: 'zzt_', app: 'test' });
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
  git(lib, sb.env, 'commit', '-q', '-a', '-m', 'registry: zzt_');
  git(lib, sb.env, 'push', '-q', 'origin', 'HEAD:main');
}

/** PATH with node and git (and /usr/bin:/bin) but without gitleaks. */
function envWithoutGitleaks(sb) {
  const bin = path.join(sb.base, 'bin-no-gitleaks');
  mkdirSync(bin, { recursive: true });
  for (const tool of ['git', 'node']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (!existsSync(path.join(bin, tool))) symlinkSync(realpathSync(found), path.join(bin, tool));
  }
  assert.ok(['/usr/bin', '/bin'].every((d) => !existsSync(path.join(d, 'gitleaks'))));
  return { ...sb.env, PATH: [bin, '/usr/bin', '/bin'].join(':') };
}

test('update_common.sh (CLAUDE.md ignored): commits the config and the workflow, installs the hooks, then is idempotent; a registry change reaches the project through the hook', { skip: NO_GITLEAKS }, () => {
  const sb = sandbox('uc-secret-');
  try {
    const { root, lib } = project(sb, { claude: 'ignored' });
    const first = updateCommon(root, sb.env);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.doesNotMatch(first.stdout + first.stderr, /pathspec|did not match|commit refused/);
    assert.equal(subjects(sb, root)[0], 'chore: secret scanning config from the template');
    assert.deepEqual(filesOf(sb, root), ['.github/workflows/secret-scan.yml', '.gitleaks.toml']);
    assert.ok(subjects(sb, root).includes('chore: refresh CLAUDE.md imports'));
    assert.equal(git(root, sb.env, 'ls-files', 'CLAUDE.md'), '', 'the ignored CLAUDE.md is never added');
    for (const name of ['pre-commit', 'pre-push']) assert.match(readFileSync(hook(root, name), 'utf8'), new RegExp(HOOK_MARKER));
    assert.equal(git(root, sb.env, 'status', '--porcelain'), '');

    const before = head(sb, root);
    const again = updateCommon(root, sb.env);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(head(sb, root), before, 'second run: no commit');
    assert.match(again.stdout, /\.gitleaks\.toml unchanged[\s\S]*secret-scan\.yml unchanged[\s\S]*pre-commit unchanged[\s\S]*pre-push unchanged/);

    publishRegistryChange(sb, lib);
    const third = updateCommon(root, sb.env);
    assert.equal(third.status, 0, third.stdout + third.stderr);
    assert.deepEqual(filesOf(sb, root), ['.gitleaks.toml'], 'regenerated and committed through the installed pre-commit hook');
    assert.match(readFileSync(path.join(root, '.gitleaks.toml'), 'utf8'), /id = "vx-zz-test-format"/);
  } finally { sb.cleanup(); }
});

test('update_common.sh: a hand-written .gitleaks.toml and a project pre-commit hook are kept (warning, chaining), twice', { skip: NO_GITLEAKS }, () => {
  const sb = sandbox('uc-secret-');
  try {
    const own = '# TradeKong-like hand-written config\n[extend]\nuseDefault = true\n';
    const { root } = project(sb, { files: { '.gitleaks.toml': own } });
    const projectHook = '#!/bin/sh\nexit 0\n';
    writeFileSync(hook(root, 'pre-commit'), projectHook);
    chmodSync(hook(root, 'pre-commit'), 0o755);
    const first = updateCommon(root, sb.env);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stderr, /\.gitleaks\.toml is hand-written, kept as is/);
    assert.equal(readFileSync(path.join(root, '.gitleaks.toml'), 'utf8'), own);
    assert.deepEqual(filesOf(sb, root), ['.github/workflows/secret-scan.yml']);
    assert.equal(readFileSync(hook(root, 'pre-commit.local'), 'utf8'), projectHook);
    assert.match(first.stdout, /pre-commit installed; the project's hook now runs after it as pre-commit\.local/);
    const before = head(sb, root);
    const again = updateCommon(root, sb.env);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(head(sb, root), before);
    assert.equal(readFileSync(hook(root, 'pre-commit.local'), 'utf8'), projectHook);
  } finally { sb.cleanup(); }
});

test('update_common.sh without gitleaks: config and workflow committed, hooks NOT installed, the way to install it printed', { skip: NO_TOOLS }, () => {
  const sb = sandbox('uc-secret-');
  try {
    const { root } = project(sb);
    const r = updateCommon(root, envWithoutGitleaks(sb));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /secret-scan hooks NOT installed: gitleaks is not on the PATH.*brew install gitleaks/);
    assert.equal(existsSync(hook(root, 'pre-commit')), false);
    assert.deepEqual(filesOf(sb, root), ['.github/workflows/secret-scan.yml', '.gitleaks.toml']);
  } finally { sb.cleanup(); }
});

test('update_common.sh: a commit of its own refused by the hook (gitleaks gone) is reported as an error, not ignored', { skip: NO_GITLEAKS }, () => {
  const sb = sandbox('uc-secret-');
  try {
    const { root, lib } = project(sb);
    assert.equal(updateCommon(root, sb.env).status, 0);
    publishRegistryChange(sb, lib);
    const before = head(sb, root);
    const r = updateCommon(root, envWithoutGitleaks(sb));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /gitleaks is not installed/);
    assert.match(r.stderr, /commit refused: see the message above/);
    assert.doesNotMatch(r.stdout + r.stderr, /no-verify/);
    assert.equal(head(sb, root), before);
    assert.deepEqual(git(root, sb.env, 'diff', '--cached', '--name-only').split('\n'), ['.gitleaks.toml'], 'the regenerated file stays staged');
  } finally { sb.cleanup(); }
});

test('update_common.sh (push mode): a refs bump refused by the hook is an error, the other steps still run', { skip: NO_GITLEAKS }, () => {
  const sb = sandbox('uc-secret-');
  try {
    const { root } = project(sb, { gitlinks: true });
    assert.equal(git(root, sb.env, 'ls-files', '-s', 'back/.libs/vx-public').split(' ')[0], '160000', 'the mount is a gitlink');
    const first = updateCommon(root, sb.env);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    put(root, 'back/.libs/vx-public/LOCAL.txt', 'local\n');
    const before = head(sb, root);
    const r = updateCommon(root, envWithoutGitleaks(sb), 'push');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /gitleaks is not installed/);
    assert.match(r.stderr, /vx-public: refs bump refused/);
    assert.match(r.stdout + r.stderr, /secret-scan hooks NOT installed|CLAUDE\.md|Sync completed with errors/, 'the later steps ran');
    assert.match(r.stdout + r.stderr, /Sync completed with errors/);
    assert.equal(head(sb, root), before, 'nothing committed');
    assert.ok(git(root, sb.env, 'diff', '--cached', '--name-only').split('\n').includes('back/.libs/vx-public'), 'the bump stays staged');
  } finally { sb.cleanup(); }
});
