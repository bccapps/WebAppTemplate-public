/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Installs the desktop shell option into a project: copy of `template/desktop/` (without build output), the
 * `build-desktop.yml` workflow, `desktop/desktop.config.json` filled from the answers and the `desktop:dev` /
 * `desktop:build` scripts of `back/package.local.json`. Shared by create-project.mjs and add-desktop.mjs.
 * Nothing existing is overwritten: `planDesktopInstall` reports what is in the way.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { syncTauriConf } from '../../desktop/scripts/sync-tauri-config.mjs';
import { buildDesktopConfig, withDesktopScripts } from './project-engine.mjs';

const SKIPPED_DIRS = new Set(['node_modules', 'target', 'build', 'gen']);
const WORKFLOW = path.join('.github', 'workflows', 'build-desktop.yml');

function walk(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...walk(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Files to copy, as `{ from, to }` (relative to the template root / the project root). */
export function desktopFiles(templateRoot) {
  const files = walk(path.join(templateRoot, 'desktop')).map((rel) => ({ from: path.join('desktop', rel), to: path.join('desktop', rel) }));
  if (existsSync(path.join(templateRoot, '.github', 'workflows', 'build-desktop.yml'))) files.push({ from: WORKFLOW, to: WORKFLOW });
  return files;
}

/**
 * What an install would do: `{ files, conflicts, scripts }`. `conflicts` = target files that already exist
 * (the whole `desktop/` folder counts as one conflict, so a half-installed shell is never completed silently).
 */
export function planDesktopInstall(root, templateRoot) {
  const files = desktopFiles(templateRoot);
  const conflicts = [];
  if (existsSync(path.join(root, 'desktop'))) conflicts.push('desktop/');
  if (existsSync(path.join(root, WORKFLOW))) conflicts.push(WORKFLOW.split(path.sep).join('/'));
  return { files, conflicts, scripts: ['desktop:dev', 'desktop:build'] };
}

/** Copy the shell, fill `desktop.config.json`, add the npm scripts. Skips files that exist when `keepExisting`. Returns copied targets. */
export function installDesktop(root, templateRoot, answers, { keepExisting = false } = {}) {
  const copied = [];
  if (!keepExisting) {
    const { conflicts } = planDesktopInstall(root, templateRoot);
    if (conflicts.length) throw new Error(`${conflicts.join(', ')} already exists: nothing overwritten`);
  }
  for (const { from, to } of desktopFiles(templateRoot)) {
    const target = path.join(root, to);
    if (existsSync(target)) {
      if (keepExisting) continue;
      throw new Error(`${to} already exists: nothing overwritten`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(templateRoot, from), target);
    copied.push(to);
  }
  const configFile = path.join(root, 'desktop', 'desktop.config.json');
  if (copied.includes(path.join('desktop', 'desktop.config.json'))) {
    const template = JSON.parse(readFileSync(configFile, 'utf8'));
    const filled = buildDesktopConfig(template, answers);
    writeFileSync(configFile, `${JSON.stringify(filled, null, 2)}\n`);
    // tauri.conf.json carries the same identity (the build syncs it again; doing it now keeps the shell tests green).
    const tauriFile = path.join(root, 'desktop', 'src-tauri', 'tauri.conf.json');
    writeFileSync(tauriFile, `${JSON.stringify(syncTauriConf(filled, JSON.parse(readFileSync(tauriFile, 'utf8'))), null, 2)}\n`);
  }
  addBackScripts(root, answers.projectName);
  return copied;
}

/** Add the desktop npm scripts to back/package.local.json (created when absent; existing scripts win). */
export function addBackScripts(root, projectName) {
  const file = path.join(root, 'back', 'package.local.json');
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { name: `${projectName}-back`, version: '0.1.0' };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(withDesktopScripts(current), null, 2)}\n`);
}
