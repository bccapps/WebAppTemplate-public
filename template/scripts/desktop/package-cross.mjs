/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Portable package (no installer) for Windows (zip) or Linux (tar.gz + launcher), with a `.sha256` file. Zero npm
 * dependencies; needs `zip` (Windows) or `tar` (Linux). Resources come from `build-desktop.mjs --target <id>`.
 *
 *   node scripts/desktop/package-cross.mjs --target win-x64|linux-x64|linux-arm64 [options]
 *
 *   --root <dir>            project root (default: current directory)
 *   --resources <dir>       resources folder (default: <root>/desktop/build/resources)
 *   --shell-binary <file>   already built shell (skips the compilation below)
 *   --out <dir>             output folder (default: <root>/desktop/dist)
 *   --version <x.y.z>       app version (default: project.config.json, else back/package.json)
 *   --dry-run               print the plan, write nothing
 *
 * Without `--shell-binary` the shell is cross-built: Windows with mingw-w64 (Rust target x86_64-pc-windows-gnu,
 * `brew install mingw-w64`); Linux in a linux Docker container (WebKitGTK cannot be cross-compiled without a sysroot).
 * Linux resources must be assembled on a case-sensitive file system. Nothing here has been run on the target hardware.
 */

import { spawnSync } from 'child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseArgs } from './build-desktop.mjs';
import {
  archiveExtension, linuxLauncher, normalizeExtraResources, packageBaseName, portableReadme, resolveTarget, resourceTopDirs, sha256File, shaFileContent,
} from './lib.mjs';

const CROSS_TARGETS = ['win-x64', 'linux-x64', 'linux-arm64'];
const BINARY = 'desktop-shell';

/** Data folder hint of the README, from the identifier (same rule as the shell: OS per-user local data folder). */
export function dataHint(target, identifier) {
  return target.os === 'win' ? `%LOCALAPPDATA%\\${identifier}` : `~/.local/share/${identifier}`;
}

/** Entries of the archive: `{ name, kind: 'file' | 'dir' }` relative to the archive top folder, for the plan. */
export function archiveLayout(productName, target, topDirs) {
  const exe = target.os === 'win' ? `${productName}.exe` : BINARY;
  const entries = [{ name: exe, kind: 'file' }];
  if (target.os === 'win') entries.push({ name: 'WebView2Loader.dll', kind: 'file' });
  else entries.push({ name: 'launch.sh', kind: 'file' });
  entries.push({ name: 'README.txt', kind: 'file' }, ...topDirs.map((d) => ({ name: d, kind: 'dir' })));
  return entries;
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${[cmd, ...args].join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) throw new Error(`${cmd} failed (exit ${res.status ?? res.signal})`);
}

function buildShell(root, target) {
  const tauri = path.join(root, 'desktop', 'src-tauri');
  const noRes = JSON.stringify({ bundle: { resources: [] } });
  if (target.os === 'win') {
    const env = {
      ...process.env, TAURI_CONFIG: noRes,
      CC_x86_64_pc_windows_gnu: 'x86_64-w64-mingw32-gcc', CXX_x86_64_pc_windows_gnu: 'x86_64-w64-mingw32-g++', AR_x86_64_pc_windows_gnu: 'x86_64-w64-mingw32-ar',
    };
    run('rustup', ['target', 'add', target.cargo], { env });
    run('cargo', ['build', '--release', '--target', target.cargo, '--features', 'tauri/custom-protocol'], { cwd: tauri, env });
    const dir = path.join(tauri, 'target', target.cargo, 'release');
    return { binary: path.join(dir, `${BINARY}.exe`), loader: path.join(dir, 'WebView2Loader.dll') };
  }
  const platform = target.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  const ctx = path.join(root, 'desktop', 'build', 'linux-builder');
  const outDir = path.join(root, 'desktop', 'build', 'linux-shell');
  mkdirSync(ctx, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(ctx, 'Dockerfile'), [
    'FROM ubuntu:22.04', 'ENV DEBIAN_FRONTEND=noninteractive',
    'RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config curl ca-certificates file libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev && rm -rf /var/lib/apt/lists/*',
    "RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable",
    'ENV PATH=/root/.cargo/bin:$PATH', '',
  ].join('\n'));
  const image = `desktop-shell-builder-${target.arch}`;
  run('docker', ['build', '--platform', platform, '-t', image, ctx]);
  const script = `set -e; mkdir -p /work && tar --exclude=./target -cf - -C /src . | tar -xf - -C /work && cd /work && `
    + `export TAURI_CONFIG='${noRes}' CARGO_TARGET_DIR=/target && cargo build --release --features tauri/custom-protocol && cp /target/release/${BINARY} /out/${BINARY}`;
  run('docker', ['run', '--rm', '--platform', platform, '-v', `${tauri}:/src:ro`, '-v', `${image}-target:/target`, '-v', `${outDir}:/out`, image, 'bash', '-c', script]);
  return { binary: path.join(outDir, BINARY) };
}

/** Stages the archive folder (small files copied, big folders linked) and archives it; returns the archive path. */
function archive({ stage, top, target, resourcesDir, topDirs, shell, productName, version, identifier, outDir, base }) {
  const dir = path.join(stage, top);
  mkdirSync(dir, { recursive: true });
  const readme = portableReadme(productName, version, target, dataHint(target, identifier));
  if (target.os === 'win') {
    copyFileSync(shell.binary, path.join(dir, `${productName}.exe`));
    if (existsSync(shell.loader)) copyFileSync(shell.loader, path.join(dir, 'WebView2Loader.dll'));
    writeFileSync(path.join(dir, 'README.txt'), readme.replace(/\n/g, '\r\n'));
  } else {
    copyFileSync(shell.binary, path.join(dir, BINARY));
    chmodSync(path.join(dir, BINARY), 0o755);
    writeFileSync(path.join(dir, 'launch.sh'), linuxLauncher(BINARY), { mode: 0o755 });
    writeFileSync(path.join(dir, 'README.txt'), readme);
  }
  for (const d of topDirs) symlinkSync(path.join(resourcesDir, d), path.join(dir, d));
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${base}.${archiveExtension(target)}`);
  rmSync(file, { force: true });
  if (target.os === 'win') run('zip', ['-r', '-q', file, top], { cwd: stage }); // zip follows symlinks
  else run('tar', ['-czhf', file, top], { cwd: stage }); // -h follows symlinks
  return file;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root ?? process.cwd());
  if (!CROSS_TARGETS.includes(opts.target)) throw new Error(`--target must be one of ${CROSS_TARGETS.join(', ')}`);
  const target = resolveTarget(opts.target);
  const desktopConfig = JSON.parse(readFileSync(path.join(root, 'desktop', 'desktop.config.json'), 'utf8'));
  const sync = await import(pathToFileURL(path.join(root, 'desktop', 'scripts', 'sync-tauri-config.mjs')).href);
  const version = sync.projectVersion(root, opts.version) ?? '0.1.0';
  const resourcesDir = path.resolve(opts.resources ?? path.join(root, 'desktop', 'build', 'resources'));
  const outDir = path.resolve(opts.out ?? path.join(root, 'desktop', 'dist'));
  const base = packageBaseName(desktopConfig.productName, version, target);
  const topDirs = resourceTopDirs(desktopConfig, normalizeExtraResources(desktopConfig.packaging?.extraResources));
  console.log(`> ${base}.${archiveExtension(target)} (shell: ${opts['shell-binary'] ?? 'cross-built'})`);
  for (const e of archiveLayout(desktopConfig.productName, target, topDirs)) console.log(`  ${base}/${e.name}${e.kind === 'dir' ? '/' : ''}`);
  if (opts['dry-run']) return console.log('> dry run: nothing written');
  if (!existsSync(path.join(resourcesDir, desktopConfig.resources?.marker ?? 'back/dist/main.js'))) {
    throw new Error(`Resources not assembled in ${resourcesDir} (run build-desktop.mjs --target ${target.id} first)`);
  }
  const shell = opts['shell-binary'] ? { binary: path.resolve(opts['shell-binary']), loader: path.join(path.dirname(path.resolve(opts['shell-binary'])), 'WebView2Loader.dll') } : buildShell(root, target);
  if (!existsSync(shell.binary)) throw new Error(`Shell binary not found: ${shell.binary}`);
  const stage = mkdtempSync(path.join(tmpdir(), 'pkg-'));
  try {
    const file = archive({ stage, top: base, target, resourcesDir, topDirs, shell, productName: desktopConfig.productName, version, identifier: desktopConfig.identifier, outDir, base });
    const hash = await sha256File(file);
    writeFileSync(`${file}.sha256`, shaFileContent(hash, path.basename(file)));
    console.log(`> ${file}\n  sha256 ${hash}`);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`ERROR ${err.message}`); process.exit(1); });
}
