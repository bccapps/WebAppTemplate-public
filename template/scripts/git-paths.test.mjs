/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Tests of lib/git-paths.sh (vx_commit_paths) and of its use by update_common.sh, with REAL git in throwaway
// repositories: a project that tracks its root CLAUDE.md, one that ignores it on purpose (`/CLAUDE.md` in .gitignore:
// AgentHub, FleetForge), one without any CLAUDE.md. Before the fix, update_common.sh stopped with
// "pathspec 'CLAUDE.md' did not match any file(s) known to git" in the ignoring project.
//
// Run: node --test scripts/git-paths.test.mjs   (needs bash, git and node; skipped otherwise)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKIP = ['bash', 'git'].some((t) => spawnSync(t, ['--version']).error) ? 'bash or git not installed' : false;

function sandbox() {
  const base = mkdtempSync(path.join(tmpdir(), 'git-paths-'));
  const home = path.join(base, 'home');
  mkdirSync(home);
  const gitconfig = path.join(home, '.gitconfig');
  writeFileSync(gitconfig, '[user]\n\tname = T\n\temail = t@example.com\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C', GIT_TERMINAL_PROMPT: '0' };
  return { base, env, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const git = (cwd, env, ...args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (root, rel, content) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
};

/** A repo with one initial commit holding `files`; `ignore` is the content of its .gitignore. */
function repo(sb, name, files, ignore) {
  const root = path.join(sb.base, name);
  mkdirSync(root);
  git(root, sb.env, 'init', '-q');
  put(root, '.gitignore', ignore);
  for (const [rel, content] of Object.entries(files)) put(root, rel, content);
  git(root, sb.env, 'add', '-A');
  git(root, sb.env, 'commit', '-q', '-m', 'init');
  return root;
}

/** Runs vx_commit_paths in `root`; returns its exit status and output. */
function vxCommit(sb, root, args) {
  const lib = path.join(SCRIPTS_DIR, 'lib/git-paths.sh');
  const r = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; shift; rc=0; vx_commit_paths "$@" || rc=$?; echo "rc=$rc"', '_', lib, ...args], {
    cwd: root, env: sb.env, encoding: 'utf8',
  });
  return { status: r.status, rc: Number(/rc=(\d+)/.exec(r.stdout)?.[1]), out: r.stdout + r.stderr };
}

const subjects = (sb, root) => git(root, sb.env, 'log', '--format=%s').split('\n');
const committedFiles = (sb, root) => git(root, sb.env, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
const staged = (sb, root) => git(root, sb.env, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();

test('the old command is what failed: `git commit -- CLAUDE.md .gitignore` with an ignored CLAUDE.md', { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const root = repo(sb, 'old', {}, '/CLAUDE.md\n');
    put(root, 'CLAUDE.md', '@x\n');
    put(root, '.gitignore', '/CLAUDE.md\n/AGENTS.md\n');
    const add = spawnSync('git', ['add', 'CLAUDE.md', '.gitignore'], { cwd: root, env: sb.env, encoding: 'utf8' });
    assert.notEqual(add.status, 0, 'git add of an ignored path fails');
    git(root, sb.env, 'add', '.gitignore');
    const commit = spawnSync('git', ['commit', '-q', '-m', 'x', '--', 'CLAUDE.md', '.gitignore'], { cwd: root, env: sb.env, encoding: 'utf8' });
    assert.notEqual(commit.status, 0);
    assert.match(commit.stderr, /did not match any file\(s\) known to git/);
  } finally { sb.cleanup(); }
});

test('vx_commit_paths: CLAUDE.md tracked -> committed with .gitignore, as before', { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const root = repo(sb, 'tracked', { 'CLAUDE.md': 'old\n', 'other.txt': 'a\n' }, 'node_modules/\n');
    put(root, 'CLAUDE.md', '@imports\n');
    put(root, '.gitignore', 'node_modules/\n/AGENTS.md\n');
    put(root, 'other.txt', 'user staged change\n');
    git(root, sb.env, 'add', 'other.txt');
    const r = vxCommit(sb, root, ['--adopt', 'chore: refresh CLAUDE.md imports', 'CLAUDE.md', '.gitignore']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.rc, 0);
    assert.equal(subjects(sb, root)[0], 'chore: refresh CLAUDE.md imports');
    assert.deepEqual(committedFiles(sb, root), ['.gitignore', 'CLAUDE.md']);
    assert.deepEqual(staged(sb, root), ['other.txt'], 'what the user staged stays staged, outside the commit');
  } finally { sb.cleanup(); }
});

test('vx_commit_paths: CLAUDE.md ignored -> only a changed .gitignore is committed, nothing forced', { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const root = repo(sb, 'ignored', {}, '/CLAUDE.md\n');
    put(root, 'CLAUDE.md', '@imports\n');
    put(root, '.gitignore', '/CLAUDE.md\n/AGENTS.md\n');
    const r = vxCommit(sb, root, ['--adopt', 'chore: refresh CLAUDE.md imports', 'CLAUDE.md', '.gitignore']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.rc, 0);
    assert.deepEqual(committedFiles(sb, root), ['.gitignore']);
    assert.equal(git(root, sb.env, 'ls-files', 'CLAUDE.md'), '', 'the ignored file is never added');
    assert.equal(existsSync(path.join(root, 'CLAUDE.md')), true);
  } finally { sb.cleanup(); }
});

test('vx_commit_paths: CLAUDE.md ignored and .gitignore unchanged -> nothing to commit, status 10, no error', { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const root = repo(sb, 'ignored-clean', {}, '/CLAUDE.md\n');
    put(root, 'CLAUDE.md', '@imports\n');
    const before = git(root, sb.env, 'rev-parse', 'HEAD');
    const r = vxCommit(sb, root, ['--adopt', 'chore: refresh CLAUDE.md imports', 'CLAUDE.md', '.gitignore']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.rc, 10);
    assert.equal(git(root, sb.env, 'rev-parse', 'HEAD'), before);
  } finally { sb.cleanup(); }
});

test('vx_commit_paths: no CLAUDE.md at all, absent or ignored paths -> no error, nothing committed', { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const root = repo(sb, 'none', {}, 'logs/\n');
    const before = git(root, sb.env, 'rev-parse', 'HEAD');
    const r = vxCommit(sb, root, ['--adopt', 'chore: x', 'CLAUDE.md', '.gitignore', 'back/package-lock.json']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.rc, 10);
    assert.equal(git(root, sb.env, 'rev-parse', 'HEAD'), before);
  } finally { sb.cleanup(); }
});

test('vx_commit_paths: an untracked, not ignored file is adopted only with --adopt', { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const root = repo(sb, 'adopt', {}, 'logs/\n');
    put(root, 'CLAUDE.md', '@imports\n');
    let r = vxCommit(sb, root, ['chore: x', 'CLAUDE.md']);
    assert.equal(r.rc, 10, 'without --adopt: untouched');
    assert.equal(git(root, sb.env, 'ls-files', 'CLAUDE.md'), '');
    r = vxCommit(sb, root, ['--adopt', 'chore: x', 'CLAUDE.md']);
    assert.equal(r.rc, 0, r.out);
    assert.deepEqual(committedFiles(sb, root), ['CLAUDE.md']);
  } finally { sb.cleanup(); }
});

test('vx_commit_paths: a tracked file that an ignore rule also matches is still committed; a file removed from disk too', { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const root = repo(sb, 'tracked-ignored', { 'CLAUDE.md': 'old\n', 'gone.txt': 'x\n' }, 'logs/\n');
    put(root, '.gitignore', 'logs/\n/CLAUDE.md\n');
    git(root, sb.env, 'commit', '-q', '-a', '-m', 'ignore it now');
    put(root, 'CLAUDE.md', 'new\n');
    rmSync(path.join(root, 'gone.txt'));
    const r = vxCommit(sb, root, ['chore: x', 'CLAUDE.md', 'gone.txt', 'missing-lock.json']);
    assert.equal(r.rc, 0, r.out);
    assert.deepEqual(committedFiles(sb, root), ['CLAUDE.md', 'gone.txt']);
  } finally { sb.cleanup(); }
});

// --- update_common.sh itself (--pull-only), with local library mounts -------------------------------------------------

const need = (t) => !spawnSync(t, ['--version']).error;

/**
 * A project whose `scripts` link reaches a fake vx-public (a bare origin holding template/scripts = the real
 * update_common.sh, lib/git-paths.sh and project-docs.mjs), mounted at back/.libs and front/.libs.
 */
function project(sb, { claude }) {
  const { base, env } = sb;
  // fake library origin
  const lib = path.join(base, 'lib-work');
  mkdirSync(path.join(lib, 'template/scripts/lib'), { recursive: true });
  for (const f of ['update_common.sh', 'project-docs.mjs', 'lib/git-paths.sh']) copyFileSync(path.join(SCRIPTS_DIR, f), path.join(lib, 'template/scripts', f));
  writeFileSync(path.join(lib, 'template/CLAUDE.md'), '# Template rules\n');
  git(lib, env, 'init', '-q');
  git(lib, env, 'add', '-A');
  git(lib, env, 'commit', '-q', '-m', 'lib');
  const origin = path.join(base, 'origin.git');
  git(base, env, 'clone', '-q', '--bare', lib, origin);

  const root = path.join(base, 'app');
  mkdirSync(root);
  git(root, env, 'init', '-q');
  writeFileSync(path.join(root, '.gitmodules'), '[submodule "back/.libs/vx-public"]\n\tpath = back/.libs/vx-public\n\turl = x\n[submodule "front/.libs/vx-public"]\n\tpath = front/.libs/vx-public\n\turl = x\n');
  for (const stack of ['back', 'front']) {
    mkdirSync(path.join(root, stack, '.libs'), { recursive: true });
    git(root, env, 'clone', '-q', origin, path.join(root, stack, '.libs/vx-public'));
    symlinkSync('vx-public/template', path.join(root, stack, '.libs/apptemplate'));
  }
  symlinkSync('front/.libs/apptemplate/scripts', path.join(root, 'scripts'));
  // The mounts are plain clones here (they would be submodules in a real project): keep them out of this repo's index.
  writeFileSync(path.join(root, '.git/info/exclude'), 'back/.libs/vx-public/\nfront/.libs/vx-public/\n');
  const ignore = claude === 'ignored' ? '/CLAUDE.md\n' : 'node_modules/\n';
  writeFileSync(path.join(root, '.gitignore'), ignore);
  if (claude === 'tracked') writeFileSync(path.join(root, 'CLAUDE.md'), 'my project notes\n');
  git(root, env, 'add', '-A');
  git(root, env, 'commit', '-q', '-m', 'init');
  return root;
}

function updateCommon(sb, root) {
  return spawnSync('bash', [path.join(root, 'scripts/update_common.sh'), '--pull-only'], { cwd: root, env: sb.env, encoding: 'utf8' });
}

const UC_SKIP = SKIP || (need('node') ? false : 'node not installed');

test('update_common.sh: a project that does not track CLAUDE.md (ignored) completes and commits only .gitignore', { skip: UC_SKIP }, () => {
  const sb = sandbox();
  try {
    const root = project(sb, { claude: 'ignored' });
    const r = updateCommon(sb, root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /pathspec|did not match/);
    assert.match(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /^@front\/\.libs\/apptemplate\/CLAUDE\.md\n/, 'CLAUDE.md is still generated on disk');
    assert.equal(git(root, sb.env, 'ls-files', 'CLAUDE.md'), '', 'and never added');
    assert.equal(subjects(sb, root)[0], 'chore: refresh CLAUDE.md imports');
    assert.deepEqual(committedFiles(sb, root), ['.gitignore']);
    // second run: nothing changed, still fine, no new commit
    const head = git(root, sb.env, 'rev-parse', 'HEAD');
    const again = updateCommon(sb, root);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(git(root, sb.env, 'rev-parse', 'HEAD'), head);
  } finally { sb.cleanup(); }
});

test('update_common.sh: a project that tracks CLAUDE.md commits it with .gitignore (unchanged behaviour)', { skip: UC_SKIP }, () => {
  const sb = sandbox();
  try {
    const root = project(sb, { claude: 'tracked' });
    const r = updateCommon(sb, root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(subjects(sb, root)[0], 'chore: refresh CLAUDE.md imports');
    assert.deepEqual(committedFiles(sb, root), ['.gitignore', 'CLAUDE.md']);
    assert.match(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /my project notes/, 'project notes kept');
  } finally { sb.cleanup(); }
});

test('update_common.sh: a project without any CLAUDE.md gets one (adopted, not ignored) in a single commit', { skip: UC_SKIP }, () => {
  const sb = sandbox();
  try {
    const root = project(sb, { claude: 'none' });
    const r = updateCommon(sb, root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(committedFiles(sb, root), ['.gitignore', 'CLAUDE.md']);
  } finally { sb.cleanup(); }
});
