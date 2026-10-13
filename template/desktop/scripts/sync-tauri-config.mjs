/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Copies `productName` and `identifier` from `desktop.config.json` (the single source) into
 * `src-tauri/tauri.conf.json`, which Tauri needs at build time. Optional `--version <x.y.z>` also sets the version
 * of `tauri.conf.json` and `Cargo.toml`. Without `--version`, the version comes from the project (`resolveVersion`):
 * `version` of `project.config.json`, else the `version` of `back/package.json`, else the one already written.
 * Run by `npm run dev` / `npm run build`; idempotent.
 *
 *   node scripts/sync-tauri-config.mjs [--version 1.2.3] [--dir <desktop dir>]
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Returns `tauriConf` with the identity fields of `desktopConfig` (and `version`, when given). */
export function syncTauriConf(desktopConfig, tauriConf, version) {
  const next = { ...tauriConf, productName: desktopConfig.productName, identifier: desktopConfig.identifier };
  if (version) next.version = version;
  return next;
}

const SEMVER = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

/**
 * Single version of the app: `--version`, else `project.config.json` `version`, else `back/package.json` `version`
 * (each given as parsed JSON or `undefined`). Returns `undefined` when none is set; throws on an invalid semver.
 */
export function resolveVersion({ cli, projectConfig, backPackage }) {
  const version = cli ?? projectConfig?.version ?? backPackage?.version;
  if (version === undefined) return undefined;
  if (!SEMVER.test(version)) throw new Error(`Invalid version "${version}" (expected x.y.z)`);
  return version;
}

/** Reads a JSON file, `undefined` when absent. */
export function readJsonIfExists(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

/** Version of the project rooted at `root` (see `resolveVersion`). */
export function projectVersion(root, cli) {
  return resolveVersion({
    cli,
    projectConfig: readJsonIfExists(path.join(root, 'project.config.json')),
    backPackage: readJsonIfExists(path.join(root, 'back', 'package.json')),
  });
}

/** Sets the `version` of the `[package]` table of a `Cargo.toml` text (only the first `version =` line). */
export function setCargoVersion(cargoToml, version) {
  return cargoToml.replace(/^version = ".*"$/m, `version = "${version}"`);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.resolve(opts.dir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const desktopConfig = JSON.parse(readFileSync(path.join(dir, 'desktop.config.json'), 'utf8'));
  const confPath = path.join(dir, 'src-tauri', 'tauri.conf.json');
  const version = projectVersion(path.join(dir, '..'), opts.version);
  const next = syncTauriConf(desktopConfig, JSON.parse(readFileSync(confPath, 'utf8')), version);
  writeFileSync(confPath, `${JSON.stringify(next, null, 2)}\n`);
  opts.version = version;
  if (opts.version) {
    const cargoPath = path.join(dir, 'src-tauri', 'Cargo.toml');
    if (existsSync(cargoPath)) writeFileSync(cargoPath, setCargoVersion(readFileSync(cargoPath, 'utf8'), opts.version));
  }
  console.log(`tauri.conf.json: ${next.productName} (${next.identifier})${opts.version ? ` v${opts.version}` : ''}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
