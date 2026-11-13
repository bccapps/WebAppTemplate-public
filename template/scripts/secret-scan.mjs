#!/usr/bin/env node
/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Secret scanning of a VX project (template README, « Secret scanning »), run by scripts/update_common.sh:
//   - config:   .gitleaks.toml generated from the secret-format registry (gitleaks-config.mjs);
//   - workflow: .github/workflows/secret-scan.yml, copied from the template (CI scan of pushes and pull requests);
//   - hooks:    .git/hooks/pre-commit and pre-push = the template's scripts/git-hooks/vx-secret-scan.sh. A project hook
//               already there is kept as <hook>.local and run after the scan; a hook directory set by core.hooksPath is
//               left alone. Installed only when gitleaks >= 8.30 is on the PATH (otherwise a warning: the hooks would
//               refuse every commit).
// Idempotent: a file that is already the template's is left untouched; a file the project wrote itself is never
// overwritten (warning).
//
//   node scripts/secret-scan.mjs setup [<root>]      the three, in this order
//   node scripts/secret-scan.mjs config|workflow|hooks [<root>]
//   node scripts/secret-scan.mjs status [<root>]     what is installed (read-only)

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGitleaksConfig } from './gitleaks-config.mjs';

const SCRIPTS_DIR = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
export const HOOK_SOURCE = path.join(SCRIPTS_DIR, 'git-hooks', 'vx-secret-scan.sh');
export const WORKFLOW_SOURCE = path.resolve(SCRIPTS_DIR, '..', '.github', 'workflows', 'secret-scan.yml');
export const WORKFLOW_TARGET = path.join('.github', 'workflows', 'secret-scan.yml');
export const HOOK_NAMES = ['pre-commit', 'pre-push'];
/** Line present in every installed hook: the installer only rewrites a hook carrying it. */
export const HOOK_MARKER = 'vx-secret-scan-hook';
/** Line present in the installed workflow, same rule. */
export const WORKFLOW_MARKER = 'vx-template: secret-scan workflow';
export const MIN_GITLEAKS_VERSION = '8.30.0';

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** `{ ok, version, reason }`: whether the hooks can run here (gitleaks on the PATH, recent enough). */
export function gitleaksStatus({ env = process.env } = {}) {
  const r = spawnSync('gitleaks', ['version'], { env, encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false, version: null, reason: 'gitleaks-missing' };
  const version = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null;
  if (version && compareVersions(version, MIN_GITLEAKS_VERSION) < 0) return { ok: false, version, reason: 'gitleaks-too-old' };
  return { ok: true, version, reason: null };
}

function gitOut(root, env, ...args) {
  const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Copies `source` to `target` unless a file without `marker` is there; `{ action: created|updated|unchanged|kept }`. */
function syncTemplateFile(source, target, marker, mode = null) {
  const next = readFileSync(source, 'utf8');
  if (!existsSync(target)) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, next);
    if (mode) chmodSync(target, mode);
    return 'created';
  }
  const current = readFileSync(target, 'utf8');
  if (!current.includes(marker)) return 'kept';
  if (current === next && (!mode || (lstatSync(target).mode & 0o777) === mode)) return 'unchanged';
  writeFileSync(target, next);
  if (mode) chmodSync(target, mode);
  return 'updated';
}

/** `.github/workflows/secret-scan.yml` of the project. */
export function installWorkflow(root) {
  return { action: syncTemplateFile(WORKFLOW_SOURCE, path.join(root, WORKFLOW_TARGET), WORKFLOW_MARKER), file: path.join(root, WORKFLOW_TARGET) };
}

/**
 * The pre-commit and pre-push hooks. `{ status: 'done' | 'skipped', reason?, hooks: [{ name, action }] }`; per hook
 * `action` is created, updated, unchanged, chained (a project hook moved to <hook>.local, run after the scan) or
 * conflict (a project hook AND a <hook>.local already exist: nothing touched).
 */
export function installHooks(root, { env = process.env, gitleaks = gitleaksStatus({ env }) } = {}) {
  if (gitOut(root, env, 'rev-parse', '--is-inside-work-tree') !== 'true') return { status: 'skipped', reason: 'not-a-repo', hooks: [] };
  if (!gitleaks.ok) return { status: 'skipped', reason: gitleaks.reason, version: gitleaks.version, hooks: [] };
  const hooksPath = gitOut(root, env, 'config', '--get', 'core.hooksPath');
  if (hooksPath) return { status: 'skipped', reason: 'hooks-path', hooksPath, hooks: [] };
  const dir = path.resolve(root, gitOut(root, env, 'rev-parse', '--git-path', 'hooks'));
  mkdirSync(dir, { recursive: true });
  const hooks = HOOK_NAMES.map((name) => {
    const target = path.join(dir, name);
    const present = existsSync(target) || isSymlink(target);
    if (present && !(existsSync(target) && readFileSync(target, 'utf8').includes(HOOK_MARKER))) {
      const chained = `${target}.local`;
      if (existsSync(chained) || isSymlink(chained)) return { name, action: 'conflict' };
      renameSync(target, chained);
      syncTemplateFile(HOOK_SOURCE, target, HOOK_MARKER, 0o755);
      return { name, action: 'chained' };
    }
    return { name, action: syncTemplateFile(HOOK_SOURCE, target, HOOK_MARKER, 0o755) };
  });
  return { status: 'done', dir, hooks };
}

function isSymlink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

const HOOK_SKIP_MESSAGES = {
  'not-a-repo': () => 'secret-scan hooks: not a git work tree, skipped',
  'gitleaks-missing': () =>
    'secret-scan hooks NOT installed: gitleaks is not on the PATH. Install it (macOS: brew install gitleaks; Linux: a release of ' +
    `https://github.com/gitleaks/gitleaks/releases, ${MIN_GITLEAKS_VERSION} or later), then re-run scripts/update_common.sh`,
  'gitleaks-too-old': (r) => `secret-scan hooks NOT installed: gitleaks ${r.version} is older than ${MIN_GITLEAKS_VERSION}; upgrade it, then re-run scripts/update_common.sh`,
  'hooks-path': (r) =>
    `secret-scan hooks NOT installed: core.hooksPath is set (${r.hooksPath}); call the template's scripts/git-hooks/vx-secret-scan.sh ` +
    'from your pre-commit and pre-push hooks (it dispatches on its file name)',
};

function report(kind, result) {
  const out = [];
  if (kind === 'workflow') {
    if (result.action === 'kept') out.push(['warn', `secret-scan workflow: ${WORKFLOW_TARGET} was written by the project, kept as is (no "${WORKFLOW_MARKER}" line)`]);
    else out.push(['info', `secret-scan workflow: ${WORKFLOW_TARGET} ${result.action}`]);
  } else if (result.status === 'skipped') {
    out.push([result.reason === 'not-a-repo' ? 'info' : 'warn', HOOK_SKIP_MESSAGES[result.reason](result)]);
  } else {
    for (const hook of result.hooks) {
      if (hook.action === 'conflict') out.push(['warn', `secret-scan hooks: ${hook.name} and ${hook.name}.local both exist and are the project's: nothing changed; merge them into ${hook.name}.local, delete ${hook.name}, re-run`]);
      else if (hook.action === 'chained') out.push(['info', `secret-scan hooks: ${hook.name} installed; the project's hook now runs after it as ${hook.name}.local`]);
      else out.push(['info', `secret-scan hooks: ${hook.name} ${hook.action}`]);
    }
  }
  for (const [level, message] of out) (level === 'warn' ? console.warn : console.log)(level === 'warn' ? `WARNING ${message}` : message);
}

/** Runs the steps; returns the exit status (1 only for an invalid .gitleaks.local.toml or an unknown step). */
export function run(step, root) {
  let status = 0;
  if (step === 'config' || step === 'setup') {
    const result = writeGitleaksConfig(root);
    if (result.status === 'invalid-local') {
      console.error(`ERROR gitleaks: ${result.file}: ${result.problems.join('; ')}`);
      status = 1;
    } else if (result.status === 'kept') {
      console.warn(`WARNING gitleaks: ${result.file} is hand-written, kept as is. Move the project's own rules and allowlists to .gitleaks.local.toml, delete .gitleaks.toml, re-run (template README, « Secret scanning »)`);
    } else {
      console.log(`gitleaks: .gitleaks.toml ${result.status}`);
    }
  }
  if (step === 'workflow' || step === 'setup') report('workflow', installWorkflow(root));
  if (step === 'hooks' || step === 'setup') report('hooks', installHooks(root));
  return status;
}

function status(root) {
  const cfg = writeGitleaksConfig(root, { check: true });
  console.log(`config:   ${cfg.status === 'unchanged' ? 'generated, up to date' : cfg.status}`);
  const wf = path.join(root, WORKFLOW_TARGET);
  console.log(`workflow: ${existsSync(wf) ? (readFileSync(wf, 'utf8').includes(WORKFLOW_MARKER) ? 'template' : 'project-owned') : 'absent'}`);
  const dir = gitOut(root, process.env, 'rev-parse', '--git-path', 'hooks');
  for (const name of HOOK_NAMES) {
    const file = dir ? path.resolve(root, dir, name) : null;
    const state = file && existsSync(file) ? (readFileSync(file, 'utf8').includes(HOOK_MARKER) ? 'installed' : 'project-owned') : 'absent';
    console.log(`${name.padEnd(12)}${state}${file && existsSync(`${file}.local`) ? ` (+ ${name}.local)` : ''}`);
  }
  const gl = gitleaksStatus();
  console.log(`gitleaks: ${gl.ok ? gl.version ?? 'present' : gl.reason}`);
  return 0;
}

const STEPS = ['setup', 'config', 'workflow', 'hooks', 'status'];

function main(argv) {
  const [step, rootArg] = argv;
  if (!STEPS.includes(step)) {
    console.error(`usage: secret-scan.mjs ${STEPS.join('|')} [<project root>]`);
    return 2;
  }
  const root = path.resolve(rootArg ?? process.cwd());
  return step === 'status' ? status(root) : run(step, root);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
