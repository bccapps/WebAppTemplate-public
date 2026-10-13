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
 * of `tauri.conf.json` and `Cargo.toml`. Run by `npm run dev` / `npm run build`; idempotent.
 *
 *   node scripts/sync-tauri-config.mjs [--version 1.2.3] [--dir <desktop dir>]
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Returns `tauriConf` with the identity fields of `desktopConfig` (and `version`, when given). */
export function syncTauriConf(desktopConfig, tauriConf, version) {
  const next = { ...tauriConf, productName: desktopConfig.productName, identifier: desktopConfig.identifier };
  if (version) next.version = version;
  return next;
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
  const next = syncTauriConf(desktopConfig, JSON.parse(readFileSync(confPath, 'utf8')), opts.version);
  writeFileSync(confPath, `${JSON.stringify(next, null, 2)}\n`);
  if (opts.version) {
    const cargoPath = path.join(dir, 'src-tauri', 'Cargo.toml');
    if (existsSync(cargoPath)) writeFileSync(cargoPath, setCargoVersion(readFileSync(cargoPath, 'utf8'), opts.version));
  }
  console.log(`tauri.conf.json: ${next.productName} (${next.identifier})${opts.version ? ` v${opts.version}` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
