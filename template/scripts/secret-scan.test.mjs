/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Tests of secret-scan.mjs and of the hook it installs (git-hooks/vx-secret-scan.sh), with REAL git and gitleaks in
// throwaway repositories: a staged secret is refused, a fake-marked value passes, a project hook is kept and chained,
// gitleaks missing refuses with the way to install it (never a bypass), pre-push scans only what the remote lacks; and
// the Scan step of the template workflow, run locally with bash. Every secret is random, built at run time.
//
// Run: node --test scripts/secret-scan.test.mjs   (needs bash, git; the scans need gitleaks >= 8.30, skipped otherwise)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderGitleaksConfig } from './gitleaks-config.mjs';
import { loadSecretFormats } from './lib/secret-formats.mjs';
import { fakeSample, formatSamples, git, gitTry, put, sandbox } from './lib/secret-scan-testkit.mjs';
import {
  HOOK_MARKER, HOOK_SOURCE, WORKFLOW_MARKER, WORKFLOW_SOURCE, WORKFLOW_TARGET, gitleaksStatus, installHooks, installWorkflow,
} from './secret-scan.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'secret-scan.mjs');
const registry = loadSecretFormats();
const NO_GIT = ['bash', 'git'].some((t) => spawnSync(t, ['--version']).error) ? 'bash or git not installed' : false;
const GITLEAKS = gitleaksStatus();
const NO_SCAN = NO_GIT || (GITLEAKS.ok ? false : `gitleaks unusable (${GITLEAKS.reason})`);
const OK_GITLEAKS = { ok: true, version: '8.30.1', reason: null };

const tkValue = () => formatSamples(registry).find((s) => s.rule === 'vx-tradekong-mcp-token').value;
const tkFake = () => fakeSample(registry, registry.formats.find((f) => f.prefix === 'tk_'), 'FAKE');

/** A project repository with the generated .gitleaks.toml committed. */
function project(sb, name = 'app') {
  const root = path.join(sb.base, name);
  mkdirSync(root);
  git(root, sb.env, 'init', '-q');
  put(root, '.gitleaks.toml', renderGitleaksConfig(registry));
  put(root, 'README.md', '# app\n');
  git(root, sb.env, 'add', '-A');
  git(root, sb.env, 'commit', '-q', '-m', 'init');
  return root;
}

const hooksDir = (root) => path.join(root, '.git', 'hooks');
const commit = (sb, root, file, content, message = 'change') => {
  put(root, file, content);
  git(root, sb.env, 'add', file);
  return gitTry(root, sb.env, 'commit', '-q', '-m', message);
};

/** PATH with git (and the POSIX tools from /usr/bin:/bin) but without gitleaks. */
function pathWithoutGitleaks(sb) {
  const bin = path.join(sb.base, 'bin-no-gitleaks');
  mkdirSync(bin);
  const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  symlinkSync(realpathSync(gitPath), path.join(bin, 'git'));
  const dirs = [bin, '/usr/bin', '/bin'];
  assert.ok(dirs.every((d) => !existsSync(path.join(d, 'gitleaks'))), 'gitleaks found in a system directory: cannot simulate its absence');
  return dirs.join(':');
}

test('installHooks: nothing is installed without a usable gitleaks, nor when core.hooksPath is set', { skip: NO_GIT }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    const missing = installHooks(root, { env: sb.env, gitleaks: { ok: false, version: null, reason: 'gitleaks-missing' } });
    assert.deepEqual([missing.status, missing.reason], ['skipped', 'gitleaks-missing']);
    assert.equal(existsSync(path.join(hooksDir(root), 'pre-commit')), false);
    git(root, sb.env, 'config', 'core.hooksPath', '.husky');
    const custom = installHooks(root, { env: sb.env, gitleaks: OK_GITLEAKS });
    assert.deepEqual([custom.status, custom.reason, custom.hooksPath], ['skipped', 'hooks-path', '.husky']);
    assert.equal(existsSync(path.join(root, '.husky')), false);
    assert.equal(installHooks(sb.base, { env: sb.env, gitleaks: OK_GITLEAKS }).reason, 'not-a-repo');
  } finally { sb.cleanup(); }
});

test('installHooks: creates both hooks (executable, the template file), then is idempotent and refreshes a stale copy', { skip: NO_GIT }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    const first = installHooks(root, { env: sb.env, gitleaks: OK_GITLEAKS });
    assert.deepEqual(first.hooks.map((h) => `${h.name}:${h.action}`), ['pre-commit:created', 'pre-push:created']);
    for (const name of ['pre-commit', 'pre-push']) {
      const file = path.join(hooksDir(root), name);
      assert.equal(readFileSync(file, 'utf8'), readFileSync(HOOK_SOURCE, 'utf8'));
      assert.equal(statSync(file).mode & 0o777, 0o755);
    }
    assert.deepEqual(installHooks(root, { env: sb.env, gitleaks: OK_GITLEAKS }).hooks.map((h) => h.action), ['unchanged', 'unchanged']);
    writeFileSync(path.join(hooksDir(root), 'pre-push'), `#!/bin/sh\n# ${HOOK_MARKER} (older copy)\nexit 0\n`);
    assert.deepEqual(installHooks(root, { env: sb.env, gitleaks: OK_GITLEAKS }).hooks.map((h) => h.action), ['unchanged', 'updated']);
    assert.equal(readFileSync(path.join(hooksDir(root), 'pre-push'), 'utf8'), readFileSync(HOOK_SOURCE, 'utf8'));
  } finally { sb.cleanup(); }
});

test('installHooks: a project hook is kept as <hook>.local and chained; with a .local too, nothing is touched', { skip: NO_GIT }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    const own = '#!/bin/sh\necho project-hook >> "$(git rev-parse --show-toplevel)/.git/hook-ran"\n';
    writeFileSync(path.join(hooksDir(root), 'pre-commit'), own);
    chmodSync(path.join(hooksDir(root), 'pre-commit'), 0o755);
    writeFileSync(path.join(hooksDir(root), 'pre-push'), '#!/bin/sh\nexit 0\n');
    writeFileSync(path.join(hooksDir(root), 'pre-push.local'), '#!/bin/sh\nexit 0\n');
    const result = installHooks(root, { env: sb.env, gitleaks: OK_GITLEAKS });
    assert.deepEqual(result.hooks.map((h) => `${h.name}:${h.action}`), ['pre-commit:chained', 'pre-push:conflict']);
    assert.equal(readFileSync(path.join(hooksDir(root), 'pre-commit.local'), 'utf8'), own);
    assert.match(readFileSync(path.join(hooksDir(root), 'pre-commit'), 'utf8'), new RegExp(HOOK_MARKER));
    assert.equal(readFileSync(path.join(hooksDir(root), 'pre-push'), 'utf8'), '#!/bin/sh\nexit 0\n');
    assert.deepEqual(installHooks(root, { env: sb.env, gitleaks: OK_GITLEAKS }).hooks.map((h) => h.action), ['unchanged', 'conflict']);
  } finally { sb.cleanup(); }
});

test('installWorkflow: copies the template workflow, keeps it up to date, never touches a project-owned one', () => {
  const sb = sandbox();
  try {
    const root = path.join(sb.base, 'wf');
    mkdirSync(root);
    assert.equal(installWorkflow(root).action, 'created');
    assert.equal(readFileSync(path.join(root, WORKFLOW_TARGET), 'utf8'), readFileSync(WORKFLOW_SOURCE, 'utf8'));
    assert.equal(installWorkflow(root).action, 'unchanged');
    writeFileSync(path.join(root, WORKFLOW_TARGET), `# ${WORKFLOW_MARKER}\nold\n`);
    assert.equal(installWorkflow(root).action, 'updated');
    writeFileSync(path.join(root, WORKFLOW_TARGET), 'name: mine\n');
    assert.equal(installWorkflow(root).action, 'kept');
    assert.equal(readFileSync(path.join(root, WORKFLOW_TARGET), 'utf8'), 'name: mine\n');
  } finally { sb.cleanup(); }
});

test('pre-commit: a staged secret is refused (value never printed), a fake-marked value and a clean change pass', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    installHooks(root, { env: sb.env });
    const secret = tkValue();
    const refused = commit(sb, root, 'config/app.env', `TRADEKONG_TOKEN=${secret}\n`);
    assert.notEqual(refused.status, 0);
    assert.match(refused.out, /commit refused/);
    assert.ok(!refused.out.includes(secret.slice(3, 20)), 'the secret is redacted');
    assert.doesNotMatch(refused.out, /no-verify/);
    assert.equal(gitTry(root, sb.env, 'log', '-1', '--format=%s').out.trim(), 'init');
    git(root, sb.env, 'reset', '-q', '--', 'config/app.env');
    assert.equal(commit(sb, root, 'spec/fixture.txt', `token ${tkFake()}\n`).status, 0);
    assert.equal(commit(sb, root, 'README.md', '# app, clean\n').status, 0);
  } finally { sb.cleanup(); }
});

/** Stages several files and commits them; returns `{ status, out }`. */
function commitFiles(sb, root, files, message = 'change') {
  for (const [file, content] of Object.entries(files)) {
    put(root, file, content);
    git(root, sb.env, 'add', file);
  }
  return gitTry(root, sb.env, 'commit', '-q', '-m', message);
}

test('pre-commit: a "gitleaks:allow" comment does not let a secret through', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    installHooks(root, { env: sb.env });
    const r = commit(sb, root, 'leak.py', `TOKEN = "${tkValue()}"  # gitleaks:allow\n`);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /commit refused: a secret was found/);
  } finally { sb.cleanup(); }
});

test('pre-commit: the configuration being committed never applies to its own commit (ignore file, allowlist), with a warning', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    installHooks(root, { env: sb.env });
    const secret = tkValue();
    // The fingerprint of the finding to come, added in the same commit as the secret.
    const ignored = commitFiles(sb, root, { '.gitleaksignore': 'leak.txt:vx-tradekong-mcp-token:1\n', 'leak.txt': `k ${secret}\n` });
    assert.notEqual(ignored.status, 0);
    assert.match(ignored.out, /WARNING: this commit changes the secret-scan configuration \(\.gitleaksignore \)/);
    assert.match(ignored.out, /commit refused: a secret was found/);
    git(root, sb.env, 'reset', '-q', '--', 'leak.txt', '.gitleaksignore');
    // An allowlist that would accept any tk_ value, in the same commit as the secret.
    const own = readFileSync(path.join(root, '.gitleaks.toml'), 'utf8');
    const allowed = commitFiles(sb, root, { '.gitleaks.toml': `${own}\n[[allowlists]]\nregexes = ['''^tk_''']\n`, 'leak.txt': `k ${secret}\n` });
    assert.notEqual(allowed.status, 0);
    assert.match(allowed.out, /WARNING: this commit changes the secret-scan configuration \(\.gitleaks\.toml \)/);
    git(root, sb.env, 'reset', '-q', '--', 'leak.txt', '.gitleaks.toml');
    // Reviewed and committed on its own, the ignore entry then applies (it is HEAD's).
    assert.equal(commitFiles(sb, root, { '.gitleaksignore': 'leak.txt:vx-tradekong-mcp-token:1\n' }, 'ignore a known vector').status, 0);
    assert.equal(commitFiles(sb, root, { 'leak.txt': `k ${secret}\n` }).status, 0);
  } finally { sb.cleanup(); }
});

test('pre-commit: a gitleaks failure (unreadable configuration) is told apart from a leak; GITLEAKS_CONFIG is ignored', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    installHooks(root, { env: sb.env });
    const permissive = path.join(sb.base, 'permissive.toml');
    writeFileSync(permissive, 'title = "nothing"\n');
    const viaEnv = { ...sb.env, GITLEAKS_CONFIG: permissive, GITLEAKS_CONFIG_TOML: 'title = "nothing"\n' };
    put(root, 'leak.txt', `k ${tkValue()}\n`);
    git(root, viaEnv, 'add', 'leak.txt');
    const r = gitTry(root, viaEnv, 'commit', '-q', '-m', 'x');
    assert.notEqual(r.status, 0);
    assert.match(r.out, /a secret was found/);
    git(root, sb.env, 'reset', '-q', '--', 'leak.txt');
    assert.equal(commitFiles(sb, root, { '.gitleaks.toml': 'garbage = [\n' }, 'broken config').status, 0, 'scanned with the previous one');
    const broken = commit(sb, root, 'ok.txt', 'fine\n');
    assert.notEqual(broken.status, 0);
    assert.match(broken.out, /gitleaks failed \(exit 1/);
    assert.doesNotMatch(broken.out, /a secret was found/);
  } finally { sb.cleanup(); }
});

test('pre-commit in a repository without history: the work-tree configuration, the secret refused', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = path.join(sb.base, 'fresh');
    mkdirSync(root);
    git(root, sb.env, 'init', '-q');
    put(root, '.gitleaks.toml', renderGitleaksConfig(registry));
    installHooks(root, { env: sb.env });
    const r = commitFiles(sb, root, { '.gitleaks.toml': renderGitleaksConfig(registry), 'leak.txt': `k ${tkValue()}\n` });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /a secret was found/);
  } finally { sb.cleanup(); }
});

test('pre-push: a merge commit that brings a secret of its own is refused', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    const bare = path.join(sb.base, 'origin.git');
    git(sb.base, sb.env, 'init', '-q', '--bare', bare);
    git(root, sb.env, 'remote', 'add', 'origin', bare);
    git(root, sb.env, 'push', '-q', 'origin', 'main');
    git(root, sb.env, 'checkout', '-q', '-b', 'side');
    assert.equal(commit(sb, root, 'side.txt', 'side\n').status, 0);
    git(root, sb.env, 'checkout', '-q', 'main');
    assert.equal(commit(sb, root, 'main.txt', 'main\n').status, 0);
    git(root, sb.env, 'merge', '-q', '--no-commit', 'side');
    put(root, 'evil.txt', `k ${tkValue()}\n`);
    git(root, sb.env, 'add', 'evil.txt');
    git(root, sb.env, 'commit', '-q', '-m', 'merge');
    installHooks(root, { env: sb.env });
    const r = gitTry(root, sb.env, 'push', '-q', 'origin', 'main');
    assert.notEqual(r.status, 0);
    assert.match(r.out, /push refused: a secret was found/);
  } finally { sb.cleanup(); }
});

test('pre-commit: the chained project hook runs after a clean scan, never after a refused one', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    const marker = path.join(root, '.git', 'hook-ran');
    writeFileSync(path.join(hooksDir(root), 'pre-commit'), `#!/bin/sh\necho ran >> "${marker}"\n`);
    chmodSync(path.join(hooksDir(root), 'pre-commit'), 0o755);
    installHooks(root, { env: sb.env });
    assert.notEqual(commit(sb, root, 'leak.txt', `k ${tkValue()}\n`).status, 0);
    assert.equal(existsSync(marker), false);
    git(root, sb.env, 'reset', '-q', '--', 'leak.txt');
    assert.equal(commit(sb, root, 'ok.txt', 'fine\n').status, 0);
    assert.equal(readFileSync(marker, 'utf8'), 'ran\n');
  } finally { sb.cleanup(); }
});

test('without gitleaks on the PATH: commit and push are refused with the way to install it, never a bypass', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    installHooks(root, { env: sb.env });
    const env = { ...sb.env, PATH: pathWithoutGitleaks(sb) };
    put(root, 'a.txt', 'a\n');
    git(root, env, 'add', 'a.txt');
    const r = gitTry(root, env, 'commit', '-q', '-m', 'a');
    assert.notEqual(r.status, 0);
    assert.match(r.out, /gitleaks is not installed/);
    assert.match(r.out, /brew install gitleaks/);
    assert.doesNotMatch(r.out, /no-verify|--no-/);
    const bare = path.join(sb.base, 'origin.git');
    git(sb.base, sb.env, 'init', '-q', '--bare', bare);
    git(root, sb.env, 'remote', 'add', 'origin', bare);
    const push = gitTry(root, env, 'push', '-q', 'origin', 'main');
    assert.notEqual(push.status, 0);
    assert.match(push.out, /secret scan \(pre-push\): gitleaks is not installed/);
  } finally { sb.cleanup(); }
});

test('pre-push: scans the commits the remote lacks (a leak pushed earlier is not rescanned), feeds the chained hook', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    const bare = path.join(sb.base, 'origin.git');
    git(sb.base, sb.env, 'init', '-q', '--bare', bare);
    git(root, sb.env, 'remote', 'add', 'origin', bare);
    // History from before the hooks: one leaking commit, already on the remote.
    assert.equal(commit(sb, root, 'old.txt', `k ${tkValue()}\n`, 'old leak').status, 0);
    git(root, sb.env, 'push', '-q', 'origin', 'main');
    const refs = path.join(root, '.git', 'push-stdin');
    writeFileSync(path.join(hooksDir(root), 'pre-push'), `#!/bin/sh\ncat > "${refs}"\n`);
    chmodSync(path.join(hooksDir(root), 'pre-push'), 0o755);
    installHooks(root, { env: sb.env });

    assert.equal(commit(sb, root, 'new.txt', 'clean\n').status, 0);
    const ok = gitTry(root, sb.env, 'push', '-q', 'origin', 'main');
    assert.equal(ok.status, 0, ok.out);
    assert.match(readFileSync(refs, 'utf8'), /^refs\/heads\/main [0-9a-f]{40} refs\/heads\/main [0-9a-f]{40}\n$/);

    // A leaking commit made while the hooks were off (here: before they are re-installed) is refused at push time.
    const leakDir = path.join(sb.base, 'clone');
    git(sb.base, sb.env, 'clone', '-q', bare, leakDir);
    assert.equal(commit(sb, leakDir, 'leak.txt', `k ${tkValue()}\n`, 'leak').status, 0);
    assert.equal(commit(sb, leakDir, 'more.txt', 'more\n', 'more').status, 0);
    installHooks(leakDir, { env: sb.env });
    const refused = gitTry(leakDir, sb.env, 'push', '-q', 'origin', 'main');
    assert.notEqual(refused.status, 0);
    assert.match(refused.out, /push refused/);
    assert.doesNotMatch(refused.out, /no-verify/);
    // A new branch: only its own commits count.
    git(root, sb.env, 'checkout', '-q', '-b', 'feature');
    assert.equal(commit(sb, root, 'feature.txt', 'feature\n').status, 0);
    assert.equal(gitTry(root, sb.env, 'push', '-q', 'origin', 'feature').status, 0);
  } finally { sb.cleanup(); }
});

test('called by name from another hook manager (core.hooksPath): vx-secret-scan.sh pre-commit', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    put(root, '.husky/pre-commit', `#!/bin/sh\nexec sh "${HOOK_SOURCE}" pre-commit "$@"\n`);
    chmodSync(path.join(root, '.husky/pre-commit'), 0o755);
    git(root, sb.env, 'config', 'core.hooksPath', '.husky');
    const refused = commit(sb, root, 'leak.txt', `k ${tkValue()}\n`);
    assert.notEqual(refused.status, 0);
    assert.match(refused.out, /secret scan \(pre-commit\): commit refused/);
    git(root, sb.env, 'reset', '-q', '--', 'leak.txt');
    assert.equal(commit(sb, root, 'ok.txt', 'ok\n').status, 0);
  } finally { sb.cleanup(); }
});

test('a linked worktree shares the hooks: a secret committed there is refused too', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    installHooks(root, { env: sb.env });
    const wt = path.join(sb.base, 'wt');
    git(root, sb.env, 'worktree', 'add', '-q', '-b', 'agent', wt);
    assert.notEqual(commit(sb, wt, 'leak.txt', `k ${tkValue()}\n`).status, 0);
    git(wt, sb.env, 'reset', '-q', '--', 'leak.txt');
    assert.equal(commit(sb, wt, 'ok.txt', 'ok\n').status, 0);
  } finally { sb.cleanup(); }
});

test('the hook is POSIX: same verdicts when dash runs it (the /bin/sh of Debian and Ubuntu)', { skip: NO_SCAN || (existsSync('/bin/dash') ? false : 'no /bin/dash') }, () => {
  const sb = sandbox();
  try {
    const root = project(sb);
    installHooks(root, { env: sb.env });
    for (const name of ['pre-commit', 'pre-push']) {
      const file = path.join(hooksDir(root), name);
      writeFileSync(file, readFileSync(file, 'utf8').replace(/^#!\/bin\/sh\n/, '#!/bin/dash\n'));
    }
    assert.notEqual(commit(sb, root, 'leak.txt', `k ${tkValue()}\n`).status, 0);
    git(root, sb.env, 'reset', '-q', '--', 'leak.txt');
    assert.equal(commit(sb, root, 'fake.txt', `k ${tkFake()}\n`).status, 0);
    const bare = path.join(sb.base, 'origin.git');
    git(sb.base, sb.env, 'init', '-q', '--bare', bare);
    git(root, sb.env, 'remote', 'add', 'origin', bare);
    const push = gitTry(root, sb.env, 'push', '-q', 'origin', 'main');
    assert.equal(push.status, 0, push.out);
  } finally { sb.cleanup(); }
});

test('CLI: setup writes the config and the workflow, installs the hooks; status reads them back', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const root = path.join(sb.base, 'cli');
    mkdirSync(root);
    git(root, sb.env, 'init', '-q');
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: sb.env, encoding: 'utf8' });
    const setup = run('setup', root);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    assert.match(setup.stdout, /\.gitleaks\.toml written[\s\S]*secret-scan.yml created[\s\S]*pre-commit created[\s\S]*pre-push created/);
    const status = run('status', root);
    assert.match(status.stdout, /config: +generated, up to date\nworkflow: template\npre-commit +installed\npre-push +installed\n/);
    assert.equal(run('bogus', root).status, 2);
  } finally { sb.cleanup(); }
});

// --- the Scan step of the template workflow, run locally --------------------------------------------------------------

/** The `run:` block of the "Scan" step of secret-scan.yml (indentation-based extraction). */
function scanStepScript() {
  const lines = readFileSync(WORKFLOW_SOURCE, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^\s+- name: Scan$/.test(l));
  const runAt = lines.findIndex((l, i) => i > start && /^\s+run: \|$/.test(l));
  const indent = /^(\s*)/.exec(lines[runAt + 1])[1].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length && (lines[i].trim() === '' || /^(\s*)/.exec(lines[i])[1].length >= indent); i += 1) body.push(lines[i].slice(indent));
  return body.join('\n');
}

test('workflow Scan step: push range, new branch, pull request, manual run', { skip: NO_SCAN }, () => {
  const sb = sandbox();
  try {
    const runner = path.join(sb.base, 'runner');
    mkdirSync(runner);
    symlinkSync(realpathSync(spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).stdout.trim()), path.join(runner, 'gitleaks'));
    const script = scanStepScript();
    const upstream = project(sb, 'upstream');
    const secrets = [tkValue(), tkValue()];
    assert.equal(commit(sb, upstream, 'old.txt', `k ${secrets[0]}\n`, 'old leak').status, 0);
    const oldLeak = git(upstream, sb.env, 'rev-parse', 'HEAD');
    assert.equal(commit(sb, upstream, 'a.txt', 'a\n').status, 0);
    const cleanTip = git(upstream, sb.env, 'rev-parse', 'HEAD');
    git(upstream, sb.env, 'checkout', '-q', '-b', 'feature');
    assert.equal(commit(sb, upstream, 'f.txt', 'f\n').status, 0);
    const featureTip = git(upstream, sb.env, 'rev-parse', 'HEAD');
    git(upstream, sb.env, 'checkout', '-q', '-b', 'leaky', 'main');
    assert.equal(commit(sb, upstream, 'l.txt', `k ${secrets[1]}\n`).status, 0);
    const leakyTip = git(upstream, sb.env, 'rev-parse', 'HEAD');
    const checkout = path.join(sb.base, 'checkout');
    git(sb.base, sb.env, 'clone', '-q', '--no-local', upstream, checkout);
    for (const b of ['feature', 'leaky']) git(checkout, sb.env, 'fetch', '-q', 'origin', b);

    const scan = (vars) => spawnSync('bash', ['-c', script], { cwd: checkout, env: { ...sb.env, RUNNER_TEMP: runner, BRANCH: 'main', BEFORE: '', AFTER: '', BASE: '', HEAD: '', ...vars }, encoding: 'utf8' });
    const zeros = '0'.repeat(40);
    assert.equal(scan({ EVENT: 'push', BEFORE: oldLeak, AFTER: cleanTip }).status, 0, 'pushed range is clean');
    assert.equal(scan({ EVENT: 'push', BEFORE: cleanTip, AFTER: leakyTip, BRANCH: 'leaky' }).status, 1, 'pushed range leaks');
    assert.equal(scan({ EVENT: 'push', BEFORE: zeros, AFTER: featureTip, BRANCH: 'feature' }).status, 0, 'new branch: its own commits only');
    assert.equal(scan({ EVENT: 'push', BEFORE: zeros, AFTER: leakyTip, BRANCH: 'leaky' }).status, 1, 'new leaking branch');
    assert.equal(scan({ EVENT: 'pull_request', BASE: cleanTip, HEAD: featureTip }).status, 0);
    assert.equal(scan({ EVENT: 'pull_request', BASE: cleanTip, HEAD: leakyTip }).status, 1);
    const manual = scan({ EVENT: 'workflow_dispatch' });
    assert.equal(manual.status, 1, 'a manual run scans the whole history');
    for (const secret of secrets) assert.ok(!`${manual.stdout}${manual.stderr}`.includes(secret.slice(3, 20)), 'values are redacted');
  } finally { sb.cleanup(); }
});
