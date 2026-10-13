/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Pure helpers shared by `build-desktop.mjs` and `package-cross.mjs` (targets, Node download URLs and sums,
 * resources plan, locale collection, native module detection, archive names). Zero npm dependencies; the few
 * functions that touch the disk take their directory as an argument so tests can use fixtures.
 */

import { createHash } from 'crypto';
import { closeSync, createReadStream, lstatSync, openSync, readSync, readdirSync, statSync } from 'fs';
import path from 'path';

/** Node release embedded in the app. Pinned (not "latest") so a build is reproducible; override with `--node-version`. Pick the latest 22.x published at least two weeks ago (`date` field of https://nodejs.org/dist/index.json); 22.23.3 dates from 2026-09-23. */
export const NODE_VERSION = '22.23.3';

/** Native modules whose binary the build fetches for the target (`better-sqlite3`, via `prebuild-install`). */
export const HANDLED_NATIVE_MODULES = ['better-sqlite3'];

/** `id` -> naming of the Node distribution, of npm/prebuild-install, of the executable and of the Cargo target. */
export const TARGETS = {
  'darwin-arm64': { os: 'darwin', arch: 'arm64', nodePlatform: 'darwin', npmPlatform: 'darwin', nodeExt: 'tar.gz', nodeBin: 'bin/node', exe: 'node', format: 'macho', cargo: 'aarch64-apple-darwin' },
  'darwin-x64': { os: 'darwin', arch: 'x64', nodePlatform: 'darwin', npmPlatform: 'darwin', nodeExt: 'tar.gz', nodeBin: 'bin/node', exe: 'node', format: 'macho', cargo: 'x86_64-apple-darwin' },
  'linux-x64': { os: 'linux', arch: 'x64', nodePlatform: 'linux', npmPlatform: 'linux', nodeExt: 'tar.gz', nodeBin: 'bin/node', exe: 'node', format: 'elf', cargo: 'x86_64-unknown-linux-gnu' },
  'linux-arm64': { os: 'linux', arch: 'arm64', nodePlatform: 'linux', npmPlatform: 'linux', nodeExt: 'tar.gz', nodeBin: 'bin/node', exe: 'node', format: 'elf', cargo: 'aarch64-unknown-linux-gnu' },
  'win-x64': { os: 'win', arch: 'x64', nodePlatform: 'win', npmPlatform: 'win32', nodeExt: 'zip', nodeBin: 'node.exe', exe: 'node.exe', format: 'pe', cargo: 'x86_64-pc-windows-gnu' },
};

/** Target id of the machine running the build (`process.platform` / `process.arch` values). */
export function hostTargetId(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'win' : platform;
  return `${os}-${arch}`;
}

/** Returns `{ id, ...TARGETS[id] }`; throws on an unsupported id. */
export function resolveTarget(id) {
  const target = TARGETS[id];
  if (!target) throw new Error(`Unsupported target "${id}" (expected one of: ${Object.keys(TARGETS).join(', ')})`);
  return { id, ...target };
}

/** Folder name of the Node archive, e.g. `node-v22.20.0-darwin-arm64`. */
export function nodeDistName(version, target) {
  return `node-v${version}-${target.nodePlatform}-${target.arch}`;
}

/** File name of the Node archive for `target`, e.g. `node-v22.20.0-win-x64.zip`. */
export function nodeArchiveName(version, target) {
  return `${nodeDistName(version, target)}.${target.nodeExt}`;
}

/** Official download URL of the Node archive. */
export function nodeDistUrl(version, target) {
  return `https://nodejs.org/dist/v${version}/${nodeArchiveName(version, target)}`;
}

/** Official list of SHA-256 sums of a release. */
export function nodeShasumsUrl(version) {
  return `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
}

/** Parses `SHASUMS256.txt` (`<sha256>  <file>` lines) into a Map file -> lowercase hex sum. */
export function parseShasums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** Expected sum of `fileName` in a `SHASUMS256.txt` text; throws when the release does not list it. */
export function expectedSha(shasumsText, fileName) {
  const sum = parseShasums(shasumsText).get(fileName);
  if (!sum) throw new Error(`${fileName} is not listed in SHASUMS256.txt`);
  return sum;
}

/** SHA-256 (hex) of a file, streamed. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

/** Content of a `.sha256` file (`sha256sum` format). */
export function shaFileContent(hash, fileName) {
  return `${hash}  ${fileName}\n`;
}

/** Folder of the Node runtime inside the resources (`runtime/node`), the one `desktop.config.json` points to. */
export const RUNTIME_NODE_DIR = 'runtime/node';

function assertRelative(p, what) {
  const norm = path.posix.normalize(String(p).replace(/\\/g, '/'));
  if (!p || path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || norm === '..' || norm.startsWith('../') || norm === '.') {
    throw new Error(`${what} must be a relative path inside the project (got "${p}")`);
  }
  return norm.replace(/\/$/, '');
}

/**
 * `extraResources` of `desktop.config.json` -> `[{ from, to }]` (both relative, posix). An entry is a string
 * (copied to the same relative path in the resources) or `{ from, to }`. The names the build owns are refused.
 */
export function normalizeExtraResources(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('packaging.extraResources must be an array');
  const reserved = new Set(['back', 'front', 'runtime']);
  const seen = new Set();
  return list.map((entry) => {
    const spec = typeof entry === 'string' ? { from: entry, to: entry } : entry;
    if (!spec || typeof spec !== 'object') throw new Error('packaging.extraResources entries are strings or { from, to }');
    const from = assertRelative(spec.from, 'extraResources "from"');
    const to = assertRelative(spec.to ?? spec.from, 'extraResources "to"');
    if (reserved.has(to.split('/')[0])) throw new Error(`extraResources "to" cannot be inside ${to.split('/')[0]}/ (owned by the build)`);
    if (seen.has(to)) throw new Error(`extraResources: duplicate destination "${to}"`);
    seen.add(to);
    return { from, to };
  });
}

/** `packaging` section of `desktop.config.json` with defaults: `{ nodeVersion, extraResources }`. */
export function readPackaging(desktopConfig, cliNodeVersion) {
  const packaging = desktopConfig.packaging ?? {};
  return {
    nodeVersion: cliNodeVersion ?? packaging.nodeVersion ?? NODE_VERSION,
    extraResources: normalizeExtraResources(packaging.extraResources),
  };
}

/** Top-level folders of the resources folder (marker, front, runtime, extra resources), sorted. */
export function resourceTopDirs(desktopConfig, extraResources) {
  const marker = desktopConfig.resources?.marker ?? 'back/dist/main.js';
  const frontDir = desktopConfig.resources?.frontDir ?? 'front/dist';
  const tops = new Set([marker.split('/')[0], frontDir.split('/')[0], 'runtime', ...extraResources.map((r) => r.to.split('/')[0])]);
  return [...tops].sort();
}

/**
 * Plan of the resources folder: ordered steps `{ kind, from, to, note }` (`from` relative to the project root, or a
 * URL / command for non-copy steps; `to` relative to the resources folder). The marker and the front folder come from
 * `desktop.config.json` so the plan and the shell agree.
 */
export function planResources({ desktopConfig, target, nodeVersion, extraResources, sign }) {
  const marker = desktopConfig.resources?.marker ?? 'back/dist/main.js';
  const frontDir = desktopConfig.resources?.frontDir ?? 'front/dist';
  const steps = [
    { kind: 'copy', from: 'back/dist', to: 'back/dist', note: 'compiled back (source maps and .d.ts removed)' },
    { kind: 'copy', from: 'back/package.json', to: 'back/package.json', note: 'manifest read by the back at run time' },
    { kind: 'locales', from: 'back/src', to: 'back/src', note: 'src/locales + modules/**/locales/*.json (same collection as back/Dockerfile)' },
    { kind: 'npm', from: 'back/package-lock.json', to: 'back/node_modules', note: 'npm ci --omit=dev --ignore-scripts' },
    { kind: 'native', from: 'better-sqlite3', to: 'back/node_modules/better-sqlite3', note: `prebuild-install for ${target.id}, Node ${nodeVersion}` },
    { kind: 'copy', from: 'front/dist', to: frontDir, note: 'built front served by the back (SERVE_FRONT_DIR)' },
    { kind: 'node', from: nodeDistUrl(nodeVersion, target), to: `${RUNTIME_NODE_DIR}/${target.exe}`, note: 'SHA-256 checked against SHASUMS256.txt' },
  ];
  for (const r of extraResources) steps.push({ kind: 'extra', from: r.from, to: r.to, note: 'packaging.extraResources' });
  steps.push({ kind: 'check', from: marker, to: marker, note: 'marker expected by the shell (resources.marker)' });
  if (sign && target.os === 'darwin') steps.push({ kind: 'sign', from: '*', to: '*', note: 'ad hoc signature of every Mach-O file' });
  return steps;
}

/** Human readable plan (one line per step), for `--dry-run`. */
export function formatPlan(steps) {
  return steps.map((s, i) => `${String(i + 1).padStart(2)}. [${s.kind}] ${s.from} -> ${s.to}  (${s.note})`).join('\n');
}

/** True for a file the Dockerfile locale collection takes: `<anything>/locales/<anything>.json`. */
export function isLocaleFile(relPath) {
  return /(^|\/)locales\/.+\.json$/.test(relPath.replace(/\\/g, '/'));
}

/**
 * Locale JSONs of a back, relative to `back/`: everything under `src/locales`, then every `locales/*.json` under
 * `src/modules` and `src/modules_shared` (symlinks followed, like `find -L`). Sorted; missing folders are ignored.
 */
export function findLocaleFiles(backDir) {
  const found = [];
  const walk = (rel, depth) => {
    if (depth > 30) return; // guard against symlink loops
    let entries;
    try { entries = readdirSync(path.join(backDir, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = `${rel}/${entry.name}`;
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { isDir = statSync(path.join(backDir, next)).isDirectory(); } catch { continue; }
      }
      if (isDir) walk(next, depth + 1);
      else if (rel.startsWith('src/locales') || isLocaleFile(next)) found.push(next);
    }
  };
  walk('src/locales', 0);
  for (const root of ['src/modules', 'src/modules_shared']) walk(root, 0);
  return found.filter((f) => f.startsWith('src/locales/') || isLocaleFile(f)).sort();
}

const MACHO_CPU = { 0x0100000c: 'arm64', 0x01000007: 'x64' };
const ELF_MACHINE = { 0xb7: 'arm64', 0x3e: 'x64' };

/** `{ format: 'macho' | 'elf' | 'pe' | null, arch: 'arm64' | 'x64' | null }` from the first bytes of a binary. */
export function nativeInfo(header) {
  if (header.length >= 8 && header.readUInt32BE(0) === 0xcffaedfe) {
    return { format: 'macho', arch: MACHO_CPU[header.readUInt32LE(4)] ?? null };
  }
  if (header.length >= 4 && header.readUInt32BE(0) === 0xcafebabe) return { format: 'macho', arch: null }; // universal
  if (header.length >= 20 && header.readUInt32BE(0) === 0x7f454c46) {
    return { format: 'elf', arch: ELF_MACHINE[header.readUInt16LE(18)] ?? null };
  }
  if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) return { format: 'pe', arch: null };
  return { format: null, arch: null };
}

function readHeader(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(32);
    const n = readSync(fd, buf, 0, 32, 0);
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

/** Package name owning a path relative to `node_modules` (`@scope/name` aware; the last `node_modules` wins). */
export function packageOfPath(relPath) {
  const parts = relPath.replace(/\\/g, '/').split('/');
  const idx = parts.lastIndexOf('node_modules');
  const rest = idx >= 0 ? parts.slice(idx + 1) : parts;
  return rest[0]?.startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
}

/** Every `*.node` file under `nodeModulesDir`: `[{ pkg, file }]` (`file` relative to it, symlinks not followed). */
export function findNativeModules(nodeModulesDir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(path.join(nodeModulesDir, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile() && entry.name.endsWith('.node')) out.push({ pkg: packageOfPath(next), file: next });
    }
  };
  walk('');
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Native modules grouped by package with a status: `handled` (the build fetches the right binary), `mismatch`
 * (the binary is for another OS or CPU than the target) or `unverified` (present, not handled by the build: the
 * project must make sure it works for the target). `read` returns the first bytes of a file (injected in tests).
 */
export function classifyNativeModules(natives, target, read, handled = HANDLED_NATIVE_MODULES) {
  const byPkg = new Map();
  for (const { pkg, file } of natives) {
    const info = nativeInfo(read(file));
    const wrong = info.format !== null && (info.format !== target.format || (info.arch && info.arch !== target.arch));
    const entry = byPkg.get(pkg) ?? { pkg, files: [], status: handled.includes(pkg) ? 'handled' : 'unverified' };
    entry.files.push(file);
    if (wrong) entry.mismatch = true;
    byPkg.set(pkg, entry);
  }
  return [...byPkg.values()].map(({ mismatch, ...e }) => ({ ...e, status: mismatch ? 'mismatch' : e.status }));
}

/** Warning lines for the packages whose status is not `handled`. */
export function nativeWarnings(classified, target) {
  const lines = [];
  for (const e of classified) {
    if (e.status === 'mismatch') lines.push(`${e.pkg}: native binary built for another platform than ${target.id} (${e.files.join(', ')})`);
    else if (e.status === 'unverified') lines.push(`${e.pkg}: native module not handled by the build, check it supports ${target.id} (${e.files.join(', ')})`);
  }
  return lines;
}

/** Reads the header of a file under `nodeModulesDir` (adapter for `classifyNativeModules`). */
export function headerReader(nodeModulesDir) {
  return (file) => readHeader(path.join(nodeModulesDir, file));
}

/** True when `dir` exists and is a directory (not a symlink to one). */
export function isRealDir(dir) {
  try { return lstatSync(dir).isDirectory(); } catch { return false; }
}

/** File-system safe slug of the product name (`My App` -> `My-App`). */
export function slugify(name) {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

/** Name of the portable archive of a cross package, without extension: `<Product>-<version>-<target>`. */
export function packageBaseName(productName, version, target) {
  return `${slugify(productName)}-${version}-${target.id}`;
}

/** Archive format of a target: zip for Windows, tar.gz otherwise. */
export function archiveExtension(target) {
  return target.os === 'win' ? 'zip' : 'tar.gz';
}

/** Name of the macOS disk image: `<Product>_<version>_<arch>.dmg` (arch in Tauri naming: aarch64 / x64). */
export function dmgName(productName, version, target) {
  return `${productName}_${version}_${target.arch === 'arm64' ? 'aarch64' : target.arch}.dmg`;
}

/** Shell script placed next to the Linux binary. */
export function linuxLauncher(binaryName) {
  return `#!/bin/sh\n# Launcher of the portable build.\ncd "$(dirname "$(readlink -f "$0")")" || exit 1\nexec ./${binaryName} "$@"\n`;
}

/** Text of the README shipped in the portable archives. */
export function portableReadme(productName, version, target, dataHint) {
  const run = target.os === 'win' ? `Run "${productName}.exe".` : 'Run ./launch.sh.';
  const extra = target.os === 'win'
    ? 'Windows SmartScreen may warn because the executable is not signed: "More info" then "Run anyway".\nRequires the Microsoft Edge WebView2 Runtime (already present on Windows 11 and up-to-date Windows 10).\nExtract into a SHORT path (for example C:\\App): Windows limits paths to 260 characters.'
    : 'Requires WebKitGTK (Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1).';
  return `${productName} ${version} (${target.id}), portable build, no installer.\n\n${run}\n${extra}\n\nData folder: ${dataHint}\n`;
}
