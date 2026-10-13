/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Assembles the resources folder of the desktop app (what the shell expects, see desktop/README.md) and, with
 * `--bundle`, builds the Tauri bundle. Zero npm dependencies; needs `npm`, `tar`, and `unzip` (Windows target).
 *
 *   node scripts/desktop/build-desktop.mjs [options]
 *
 *   --root <dir>          project root (default: current directory); back/dist and front/dist must be built
 *   --target <id>         darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 | win-x64 (default: this machine)
 *   --out <dir>           resources folder (default: <root>/desktop/build/resources)
 *   --node-version <v>    Node to embed (default: packaging.nodeVersion of desktop.config.json, else the pinned one)
 *   --cache-dir <dir>     downloads cache (default: <root>/desktop/build/cache)
 *   --version <x.y.z>     app version (default: project.config.json, else back/package.json)
 *   --skip-install        keep an existing <out>/back/node_modules (no npm ci)
 *   --no-sign             do not sign ad hoc (macOS)
 *   --bundle              then run `tauri build` (macOS: app, ad hoc re-signature, then make-dmg.sh)
 *   --bundles <list>      bundles passed to `tauri build` (default: app on macOS; deb,appimage on Linux; nsis on Windows)
 *   --dry-run             print the plan, download and write nothing
 *
 * Only the target's Node and the better-sqlite3 binary change with `--target`; other native modules are listed with
 * a warning (see classifyNativeModules).
 */

import { spawnSync } from 'child_process';
import { chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  RUNTIME_NODE_DIR, classifyNativeModules, dmgName, expectedSha, findLocaleFiles, findNativeModules, formatPlan, headerReader,
  hostTargetId, nativeWarnings, nodeArchiveName, nodeDistName, nodeDistUrl, nodeShasumsUrl, planResources, readPackaging,
  resolveTarget, resourceTopDirs, sha256File,
} from './lib.mjs';

const FLAGS = new Set(['skip-install', 'no-sign', 'bundle', 'dry-run', 'help']);

/** Parses `--name value` / `--flag` arguments into an object (flags are `true`). */
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"`);
    const name = arg.slice(2);
    if (FLAGS.has(name)) opts[name] = true;
    else if (argv[i + 1] === undefined) throw new Error(`--${name} needs a value`);
    else { opts[name] = argv[i + 1]; i += 1; }
  }
  return opts;
}

/** Default `tauri build --bundles` list of a target. */
export function defaultBundles(target) {
  return { darwin: 'app', linux: 'deb,appimage', win: 'nsis' }[target.os];
}

/**
 * `TAURI_CONFIG` override merged by Tauri at build time: maps each resources sub-folder into the bundle (absolute
 * sources, so `tauri.conf.json` stays clean for `tauri dev`) and, for an ad hoc build on macOS, the `-` identity.
 */
export function tauriConfigOverride({ resourcesDir, desktopConfig, extraResources, target, sign }) {
  const resources = {};
  for (const top of resourceTopDirs(desktopConfig, extraResources)) resources[path.join(resourcesDir, top)] = top;
  const bundle = { resources };
  if (target.os === 'darwin' && sign) bundle.macOS = { signingIdentity: '-', hardenedRuntime: false };
  return { bundle };
}

function log(msg) { console.log(`> ${msg}`); }

function run(cmd, args, opts = {}) {
  console.log(`  $ ${[cmd, ...args].join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm', ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args[0] ?? ''} failed (exit ${res.status ?? res.signal})`);
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  mkdirSync(path.dirname(file), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

/** Downloads (cached) and verifies the Node archive of `target`; returns its path. */
async function fetchNode(version, target, cacheDir) {
  const name = nodeArchiveName(version, target);
  const archive = path.join(cacheDir, name);
  const shasums = await (await fetch(nodeShasumsUrl(version))).text();
  const expected = expectedSha(shasums, name);
  if (!existsSync(archive) || (await sha256File(archive)) !== expected) {
    log(`Downloading ${nodeDistUrl(version, target)}`);
    await download(nodeDistUrl(version, target), archive);
  }
  const actual = await sha256File(archive);
  if (actual !== expected) {
    rmSync(archive, { force: true });
    throw new Error(`SHA-256 mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
  log(`${name} verified (sha256 ${actual})`);
  return archive;
}

function extractNode(archive, version, target, outDir) {
  mkdirSync(outDir, { recursive: true });
  const inner = `${nodeDistName(version, target)}/${target.nodeBin}`;
  if (target.nodeExt === 'zip') {
    const unzip = spawnSync('unzip', ['-v'], { stdio: 'ignore' });
    if (unzip.status === 0) run('unzip', ['-o', '-j', archive, inner, '-d', outDir]);
    else run('tar', ['-xf', archive, '-C', outDir, '--strip-components=1', inner]);
  } else {
    run('tar', ['-xzf', archive, '-C', outDir, '--strip-components=2', inner]);
  }
  if (target.os !== 'win') chmodSync(path.join(outDir, target.exe), 0o755);
}

function copyDir(from, to) {
  if (!existsSync(from)) throw new Error(`Missing ${from} (build the project first)`);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: true });
}

/** Removes `*.js.map` and `*.d.ts` like back/Dockerfile. */
function stripBuildArtifacts(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) stripBuildArtifacts(p);
    else if (entry.name.endsWith('.js.map') || entry.name.endsWith('.d.ts')) rmSync(p);
  }
}

function copyLocales(root, out) {
  const back = path.join(root, 'back');
  const files = findLocaleFiles(back);
  for (const f of files) {
    mkdirSync(path.dirname(path.join(out, 'back', f)), { recursive: true });
    cpSync(path.join(back, f), path.join(out, 'back', f), { dereference: true });
  }
  log(`${files.length} locale files collected`);
}

function installProdModules(root, out, target, skipInstall) {
  const dest = path.join(out, 'back');
  if (skipInstall && existsSync(path.join(dest, 'node_modules'))) return log('node_modules kept (--skip-install)');
  for (const f of readdirSync(path.join(root, 'back'))) {
    if (f === 'package.json' || f === 'package-lock.json' || f.endsWith('.tgz')) cpSync(path.join(root, 'back', f), path.join(dest, f));
  }
  const cross = target.id !== hostTargetId() ? [`--os=${target.npmPlatform}`, `--cpu=${target.arch}`] : [];
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', ...cross], { cwd: dest });
}

/** Fetches the prebuilt better-sqlite3 binary for the target's platform, CPU and Node ABI. */
function fetchBetterSqlite(out, target, nodeVersion) {
  const modDir = path.join(out, 'back', 'node_modules', 'better-sqlite3');
  if (!existsSync(modDir)) return log('better-sqlite3 not installed, skipped');
  const bin = path.join(out, 'back', 'node_modules', 'prebuild-install', 'bin.js');
  if (!existsSync(bin)) throw new Error('prebuild-install not found next to better-sqlite3 (needed to fetch the target binary)');
  run(process.execPath, [bin, '--runtime', 'node', '--target', nodeVersion, '--platform', target.npmPlatform, '--arch', target.arch], { cwd: modDir });
}

function reportNatives(out, target) {
  const nm = path.join(out, 'back', 'node_modules');
  const classified = classifyNativeModules(findNativeModules(nm), target, headerReader(nm));
  for (const e of classified) log(`native module ${e.pkg}: ${e.status} (${e.files.length} file(s))`);
  for (const w of nativeWarnings(classified, target)) console.warn(`WARNING ${w}`);
}

/** Ad hoc signature of every Mach-O file under `out` (Apple Silicon refuses unsigned binaries). */
function signAdHoc(out) {
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && (entry.name.endsWith('.node') || entry.name.endsWith('.dylib') || p.includes(`${path.sep}runtime${path.sep}`))) {
        const magic = readFileSync(p).subarray(0, 4).toString('hex');
        if (['cffaedfe', 'cafebabe'].includes(magic)) { spawnSync('codesign', ['--force', '--sign', '-', p], { stdio: 'ignore' }); count += 1; }
      }
    }
  };
  walk(out);
  log(`${count} Mach-O files signed (ad hoc)`);
}

function bundle({ root, out, desktopConfig, extra, target, sign, bundles, version }) {
  const desktop = path.join(root, 'desktop');
  run('node', [path.join('scripts', 'sync-tauri-config.mjs'), ...(version ? ['--version', version] : [])], { cwd: desktop });
  const override = tauriConfigOverride({ resourcesDir: out, desktopConfig, extraResources: extra, target, sign });
  run('npx', ['tauri', 'build', '--bundles', bundles], { cwd: desktop, env: { ...process.env, TAURI_CONFIG: JSON.stringify(override) }, shell: process.platform === 'win32' });
  if (target.os !== 'darwin') return;
  const bundleDir = path.join(desktop, 'src-tauri', 'target', 'release', 'bundle');
  const app = path.join(bundleDir, 'macos', `${desktopConfig.productName}.app`);
  if (sign) run('codesign', ['--force', '--deep', '--sign', '-', app]);
  const dmg = path.join(bundleDir, 'dmg', dmgName(desktopConfig.productName, version ?? '0.0.0', target));
  run('sh', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'make-dmg.sh'), '--app', app, '--name', desktopConfig.productName, '--out', dmg]);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*\n \* Assembles[\s\S]*?\*\//)[0]);
  const root = path.resolve(opts.root ?? process.cwd());
  const desktopConfig = JSON.parse(readFileSync(path.join(root, 'desktop', 'desktop.config.json'), 'utf8'));
  const target = resolveTarget(opts.target ?? hostTargetId());
  const { nodeVersion, extraResources } = readPackaging(desktopConfig, opts['node-version']);
  const out = path.resolve(opts.out ?? path.join(root, 'desktop', 'build', 'resources'));
  const sign = !opts['no-sign'];
  const sync = await import(pathToFileURL(path.join(root, 'desktop', 'scripts', 'sync-tauri-config.mjs')).href);
  const version = sync.projectVersion(root, opts.version);
  const steps = planResources({ desktopConfig, target, nodeVersion, extraResources, sign });
  log(`${desktopConfig.productName} ${version ?? '(no version)'} for ${target.id}, resources in ${out}`);
  console.log(formatPlan(steps));
  if (opts['dry-run']) return log('dry run: nothing downloaded or written');

  const cache = path.resolve(opts['cache-dir'] ?? path.join(root, 'desktop', 'build', 'cache'));
  const archive = await fetchNode(nodeVersion, target, cache);
  if (!opts['skip-install']) rmSync(out, { recursive: true, force: true });
  else rmSync(path.join(out, 'back', 'dist'), { recursive: true, force: true });
  copyDir(path.join(root, 'back', 'dist'), path.join(out, 'back', 'dist'));
  stripBuildArtifacts(path.join(out, 'back', 'dist'));
  cpSync(path.join(root, 'back', 'package.json'), path.join(out, 'back', 'package.json'));
  copyLocales(root, out);
  installProdModules(root, out, target, opts['skip-install']);
  fetchBetterSqlite(out, target, nodeVersion);
  copyDir(path.join(root, 'front', 'dist'), path.join(out, desktopConfig.resources?.frontDir ?? 'front/dist'));
  extractNode(archive, nodeVersion, target, path.join(out, RUNTIME_NODE_DIR));
  for (const r of extraResources) copyDir(path.join(root, r.from), path.join(out, r.to));
  const marker = path.join(out, desktopConfig.resources?.marker ?? 'back/dist/main.js');
  if (!existsSync(marker)) throw new Error(`Marker missing after assembly: ${marker}`);
  reportNatives(out, target);
  if (sign && target.os === 'darwin' && process.platform === 'darwin') signAdHoc(out);
  if (opts.bundle) bundle({ root, out, desktopConfig, extra: extraResources, target, sign, bundles: opts.bundles ?? defaultBundles(target), version });
  else log('Resources ready. Next: --bundle, or scripts/desktop/package-cross.mjs for a portable Windows/Linux package.');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`ERROR ${err.message}`); process.exit(1); });
}
