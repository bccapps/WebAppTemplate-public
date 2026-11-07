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
 * Add the installable-app option (PWA) to an existing project: same effects as answering « yes » to the PWA question of
 * create-project.mjs. Nothing existing is overwritten.
 *
 *   node scripts/add-pwa.mjs [--root <dir>] [--name <text>] [--short-name <text>] [--theme-color <#rrggbb>]
 *                            [--background-color <#rrggbb>] [--source <image>] [--no-install] [--no-icons]
 *                            [--allow-existing-sw] [--dry-run] [--yes]
 *
 * Copies `front/pwa.plugin.ts`, `front/pwa-assets.config.ts`, `front/src/sw.ts` and `front/src/components/PwaInstallButton.tsx`,
 * writes the `pwa` section of project.config.json (when the file exists), wires `front/vite.config.ts`, `front/index.html`
 * and `front/public/_headers` (each only when its shape is recognised: otherwise the manual edit is printed), adds the packages
 * and the `pwa:icons` script to `front/package.local.json`, regenerates `front/package.json`, runs `npm install` and generates
 * the icons from the source image (`--source`, default `front/public/favicon.svg`).
 *
 * Refused when the project already has the PWA files, or another service worker (a scope has a single one: merge its handlers
 * into `front/src/sw.ts` first, or pass `--allow-existing-sw` to install anyway and merge afterwards). The install button is
 * not wired into the header (every project's header differs): the script prints the two lines to add.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ICON_SOURCE, findExistingServiceWorkers, patchHeaders, patchIndexHtml, patchPackageLocal, patchViteConfig, planPwaInstall, renderPwaFile,
  titleOf,
} from './lib/pwa-install.mjs';
import { normalizeAnswers, resolvePwa, validatePwa } from './lib/project-engine.mjs';

const TEMPLATE_ROOT = path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), '..');

const log = {
  info: (m) => console.log(`\x1b[1;34m==>\x1b[0m ${m}`),
  ok: (m) => console.log(`\x1b[1;32m✓\x1b[0m  ${m}`),
  warn: (m) => console.warn(`\x1b[1;33m⚠\x1b[0m  ${m}`),
  err: (m) => console.error(`\x1b[1;31m✖\x1b[0m  ${m}`),
};

const FLAGS = ['dry-run', 'yes', 'no-install', 'no-icons', 'allow-existing-sw'];
const VALUES = ['root', 'name', 'short-name', 'theme-color', 'background-color', 'source'];

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const key = flag.replace(/^--/, '');
    if (!flag.startsWith('--')) throw new Error(`unknown option ${argv[i]}`);
    if (FLAGS.includes(key)) opts[key] = true;
    else if (VALUES.includes(key)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`option ${flag} needs a value`);
      opts[key] = value;
    } else throw new Error(`unknown option ${argv[i]}`);
  }
  return opts;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const readIfExists = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

/** Icon source relative to `front/`: the `--source` image copied into `front/public/` when it lies elsewhere, else the favicon. */
function resolveIconSource(root, opts) {
  const front = path.join(root, 'front');
  if (opts.source) {
    const abs = path.resolve(opts.source);
    if (!existsSync(abs)) throw new Error(`--source ${opts.source} does not exist`);
    const inPublic = path.relative(path.join(front, 'public'), abs);
    const rel = inPublic.startsWith('..') ? path.posix.join('public', path.basename(abs)) : path.posix.join('public', inPublic.split(path.sep).join('/'));
    return { rel, copyFrom: inPublic.startsWith('..') ? abs : null };
  }
  return existsSync(path.join(front, DEFAULT_ICON_SOURCE)) ? { rel: DEFAULT_ICON_SOURCE, copyFrom: null } : { rel: null, copyFrom: null };
}

function run(cwd, command, args) {
  const r = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${r.status})`);
}

export async function main(argv, templateRoot = TEMPLATE_ROOT) {
  const opts = parseArgs(argv);
  const root = path.resolve(opts.root ?? process.cwd());
  const front = path.join(root, 'front');
  if (!existsSync(path.join(front, 'package.local.json')) || !existsSync(path.join(front, 'index.html'))) {
    throw new Error(`${root} has no front/package.local.json or front/index.html: not a project created by create-project (or migrated to the template)`);
  }
  const configFile = path.join(root, 'project.config.json');
  const hasConfig = existsSync(configFile);
  const saved = hasConfig ? readJson(configFile) : {};
  if (saved.pwa?.enabled) {
    log.err('the PWA option is already enabled in project.config.json: nothing to do');
    return 2;
  }
  const title = titleOf(readIfExists(path.join(front, 'index.html')) ?? '');
  const answers = normalizeAnswers({
    projectName: path.basename(root),
    ...(title ? { siteName: title } : {}),
    ...saved,
    pwa: {
      ...(saved.pwa ?? {}),
      enabled: true,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts['short-name'] ? { shortName: opts['short-name'] } : {}),
      ...(opts['theme-color'] ? { themeColor: opts['theme-color'] } : {}),
      ...(opts['background-color'] ? { backgroundColor: opts['background-color'] } : {}),
    },
  });
  const errors = validatePwa(answers);
  const { files, conflicts } = planPwaInstall(root, templateRoot);
  for (const c of conflicts) errors.push(`${c} already exists: nothing is overwritten (remove it first)`);
  const workers = findExistingServiceWorkers(root);
  if (workers.length && !opts['allow-existing-sw']) {
    errors.push(`the project already registers or implements a service worker (${workers.join(', ')}). A scope has a single service worker: `
      + 'move its handlers (push, notificationclick, ...) into front/src/sw.ts after the install and delete the old file, or pass --allow-existing-sw to install now');
  }
  let icon;
  try {
    icon = resolveIconSource(root, opts);
  } catch (error) {
    errors.push(error.message);
  }
  if (errors.length) {
    errors.forEach(log.err);
    return 2;
  }
  const pwa = resolvePwa(answers);
  log.info(`PWA: "${pwa.name}" / "${pwa.shortName}", theme ${pwa.themeColor}, background ${pwa.backgroundColor}, ${files.length} files, icons from ${icon.rel ?? '(no source image)'}`);
  if (workers.length) log.warn(`existing service worker(s) ${workers.join(', ')}: merge them into front/src/sw.ts, then delete them`);
  if (opts['dry-run']) {
    log.info('--dry-run: nothing written.');
    return 0;
  }

  for (const { from, to } of files) {
    const target = path.join(root, to);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, renderPwaFile(readFileSync(path.join(templateRoot, from), 'utf8'), pwa, icon.rel ?? DEFAULT_ICON_SOURCE));
    log.ok(`${to} created`);
  }
  if (icon.copyFrom) {
    copyFileSync(icon.copyFrom, path.join(front, icon.rel));
    log.ok(`front/${icon.rel} created (icon source)`);
  }

  const manual = [];
  const patch = (rel, apply) => {
    const file = path.join(root, rel);
    const text = readIfExists(file);
    if (text === null) return;
    const result = apply(text);
    if (result.changed) {
      writeFileSync(file, result.text);
      log.ok(`${rel} updated`);
    }
    if (result.manual) manual.push(`${rel}: ${result.manual}`);
  };
  patch('front/vite.config.ts', patchViteConfig);
  patch('front/index.html', (text) => patchIndexHtml(text, pwa));
  patch('front/public/_headers', patchHeaders);
  const localFile = path.join(front, 'package.local.json');
  const { pkg, changed } = patchPackageLocal(readJson(localFile));
  if (changed) {
    writeFileSync(localFile, `${JSON.stringify(pkg, null, 2)}\n`);
    log.ok('front/package.local.json updated');
  }
  if (hasConfig) {
    writeFileSync(configFile, `${JSON.stringify({ ...saved, pwa }, null, 2)}\n`);
    log.ok('project.config.json: pwa section written');
  } else log.warn('no project.config.json: none created (the PWA values live in front/pwa.plugin.ts)');

  const buildPackage = path.join(front, '.libs', 'apptemplate', 'scripts', 'build-package.mjs');
  if (existsSync(buildPackage)) run(front, 'node', [buildPackage, 'front']);
  else log.warn('front/.libs/apptemplate not mounted: regenerate front/package.json yourself, then npm install');
  if (!opts['no-install'] && existsSync(buildPackage)) {
    run(front, 'npm', ['install', '--no-audit', '--no-fund']);
    if (!opts['no-icons'] && icon.rel) run(front, 'npm', ['run', 'pwa:icons']);
  }

  const todo = [...manual];
  todo.push("front header: `import { PwaInstallButton } from './PwaInstallButton'` and render `<PwaInstallButton />` next to your other header actions (it shows only when the browser offers the install; a hint on iOS)");
  if (!icon.rel) todo.push('icons: put a square logo (512 px or more, SVG or PNG) in front/public, point front/pwa-assets.config.ts `images` at it and run `npm run pwa:icons` in front/ (pixel art: upscale it with nearest-neighbour first, never smooth it)');
  else if (opts['no-install'] || opts['no-icons']) todo.push('icons: run `npm install` then `npm run pwa:icons` in front/');
  todo.push('server: serve sw.js, registerSW.js and manifest.webmanifest with `Cache-Control: no-cache` (the template nginx.conf and _headers already do) and the app over HTTPS');
  log.ok('PWA added. Left to do:');
  todo.forEach((line) => console.log(`   - ${line}`));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { log.err(error.message); process.exitCode = 1; },
  );
}
