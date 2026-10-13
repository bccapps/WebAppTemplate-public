#!/usr/bin/env node
/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Add the desktop shell (Tauri) to an existing project: same effects as answering « yes » to the desktop question
 * of create-project.mjs. Nothing is overwritten.
 *
 *   node scripts/add-desktop.mjs [--root <dir>] [--name <product name>] [--identifier <com.example.app>]
 *                                [--dry-run] [--yes]
 *
 * Copies `desktop/` and `.github/workflows/build-desktop.yml`, writes the `desktop` section of project.config.json,
 * fills `desktop/desktop.config.json`, adds `desktop:dev` and `desktop:build` to back/package.local.json and
 * regenerates back/package.json. Refused when the desktop option is already present, when the project uses the
 * `user` module (the shell runs the back in local trust mode) or a database other than SQLite.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installDesktop, planDesktopInstall } from './lib/desktop-install.mjs';
import { linkedIds, normalizeAnswers, resolveDesktop, validateDesktop } from './lib/project-engine.mjs';

const TEMPLATE_ROOT = path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), '..');

const log = {
  info: (m) => console.log(`\x1b[1;34m==>\x1b[0m ${m}`),
  ok: (m) => console.log(`\x1b[1;32m✓\x1b[0m  ${m}`),
  warn: (m) => console.warn(`\x1b[1;33m⚠\x1b[0m  ${m}`),
  err: (m) => console.error(`\x1b[1;31m✖\x1b[0m  ${m}`),
};

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (['dry-run', 'yes'].includes(key)) opts[key] = true;
    else if (['root', 'name', 'identifier'].includes(key) && argv[i].startsWith('--')) {
      if (argv[i + 1] === undefined) throw new Error(`option ${argv[i]} needs a value`);
      opts[key] = argv[++i];
    } else throw new Error(`unknown option ${argv[i]}`);
  }
  return opts;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export async function main(argv, templateRoot = TEMPLATE_ROOT) {
  const opts = parseArgs(argv);
  const root = path.resolve(opts.root ?? process.cwd());
  const configFile = path.join(root, 'project.config.json');
  const sharedFile = path.join(root, 'shared-modules.json');
  if (!existsSync(configFile) || !existsSync(sharedFile)) {
    throw new Error(`${root} is not a project created by create-project (project.config.json / shared-modules.json missing)`);
  }
  const saved = readJson(configFile);
  if (saved.desktop?.enabled) {
    log.err('the desktop option is already enabled in project.config.json: nothing to do');
    return 2;
  }
  const answers = normalizeAnswers({
    ...saved,
    desktop: { ...(saved.desktop ?? {}), enabled: true, ...(opts.name ? { productName: opts.name } : {}), ...(opts.identifier ? { identifier: opts.identifier } : {}) },
  });
  const errors = validateDesktop(answers, linkedIds(readJson(sharedFile)));
  const { files, conflicts, scripts } = planDesktopInstall(root, templateRoot);
  for (const c of conflicts) errors.push(`${c} already exists: nothing is overwritten (remove it first, or set desktop.enabled by hand if the shell is already installed)`);
  if (errors.length) {
    errors.forEach(log.err);
    return 2;
  }
  const desktop = resolveDesktop(answers);
  log.info(`Desktop shell: "${desktop.productName}" (${desktop.identifier}), ${files.length} files, scripts ${scripts.join(', ')}`);
  if (/^com\.example\./.test(desktop.identifier)) log.warn('the identifier is a placeholder (com.example.*): pass --identifier <your.reverse.domain>; it names the OS data folder of the app');
  if (opts['dry-run']) {
    log.info('--dry-run: nothing written.');
    return 0;
  }
  installDesktop(root, templateRoot, answers);
  writeFileSync(configFile, `${JSON.stringify({ ...saved, desktop }, null, 2)}\n`);
  rebuildBackPackage(root);
  log.ok('Desktop shell added. Next: node scripts/desktop/build-desktop.mjs --dry-run, or `npm run desktop:dev` in back/ (Rust toolchain required).');
  return 0;
}

/** Regenerate back/package.json (the scripts live in package.local.json) when the project has its libraries mounted. */
function rebuildBackPackage(root) {
  const script = path.join(root, 'back', '.libs', 'apptemplate', 'scripts', 'build-package.mjs');
  if (!existsSync(script)) return;
  const r = spawnSync('node', [script, 'back'], { cwd: path.join(root, 'back'), stdio: 'inherit' });
  if (r.status !== 0) throw new Error('build-package.mjs failed (exit ' + r.status + ')');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { log.err(error.message); process.exitCode = 1; },
  );
}
