/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultBundles, parseArgs, tauriConfigOverride } from './build-desktop.mjs';
import { archiveLayout, dataHint } from './package-cross.mjs';
import {
  NODE_VERSION, archiveExtension, classifyNativeModules, dmgName, expectedSha, findLocaleFiles, findNativeModules, formatPlan,
  hostTargetId, isLocaleFile, linuxLauncher, nativeInfo, nativeWarnings, nodeArchiveName, nodeDistUrl, nodeShasumsUrl,
  normalizeExtraResources, packageBaseName, packageOfPath, parseShasums, planResources, portableReadme, readPackaging,
  resolveTarget, resourceTopDirs, sha256File, shaFileContent, slugify,
} from './lib.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const SHASUMS = `${HASH_A}  node-v22.20.0-darwin-arm64.tar.gz\n${HASH_B.toUpperCase()}  node-v22.20.0-win-x64.zip\nnot a line\n`;

function tmp() { return mkdtempSync(path.join(tmpdir(), 'desk-')); }
function put(root, rel, content = '{}') {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

test('target selection', () => {
  assert.equal(hostTargetId('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(hostTargetId('win32', 'x64'), 'win-x64');
  assert.equal(resolveTarget('linux-arm64').npmPlatform, 'linux');
  assert.equal(resolveTarget('win-x64').npmPlatform, 'win32');
  assert.throws(() => resolveTarget('freebsd-x64'), /Unsupported target/);
});

test('Node URLs and archive names', () => {
  assert.equal(nodeArchiveName('22.20.0', resolveTarget('darwin-arm64')), 'node-v22.20.0-darwin-arm64.tar.gz');
  assert.equal(nodeDistUrl('22.20.0', resolveTarget('win-x64')), 'https://nodejs.org/dist/v22.20.0/node-v22.20.0-win-x64.zip');
  assert.equal(nodeShasumsUrl('22.20.0'), 'https://nodejs.org/dist/v22.20.0/SHASUMS256.txt');
  assert.match(NODE_VERSION, /^\d+\.\d+\.\d+$/);
});

test('SHASUMS256 parsing and lookup', () => {
  assert.equal(parseShasums(SHASUMS).size, 2);
  assert.equal(expectedSha(SHASUMS, 'node-v22.20.0-darwin-arm64.tar.gz'), HASH_A);
  assert.equal(expectedSha(SHASUMS, 'node-v22.20.0-win-x64.zip'), HASH_B);
  assert.throws(() => expectedSha(SHASUMS, 'node-v22.20.0-linux-x64.tar.gz'), /not listed/);
});

test('sha256File matches the known digest of "abc"', async () => {
  const root = tmp();
  put(root, 'f', 'abc');
  assert.equal(await sha256File(path.join(root, 'f')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(shaFileContent('x', 'a.zip'), 'x  a.zip\n');
});

test('extraResources normalization', () => {
  assert.deepEqual(normalizeExtraResources(['engine', { from: 'e/dist', to: 'engine2' }]), [{ from: 'engine', to: 'engine' }, { from: 'e/dist', to: 'engine2' }]);
  assert.deepEqual(normalizeExtraResources(undefined), []);
  assert.throws(() => normalizeExtraResources(['../x']), /relative/);
  assert.throws(() => normalizeExtraResources(['/abs']), /relative/);
  assert.throws(() => normalizeExtraResources([{ from: 'a', to: 'back/x' }]), /owned by the build/);
  assert.throws(() => normalizeExtraResources(['a', { from: 'b', to: 'a' }]), /duplicate/);
  assert.throws(() => normalizeExtraResources('a'), /array/);
});

test('packaging defaults and overrides', () => {
  assert.equal(readPackaging({}).nodeVersion, NODE_VERSION);
  assert.equal(readPackaging({ packaging: { nodeVersion: null } }).nodeVersion, NODE_VERSION);
  assert.equal(readPackaging({ packaging: { nodeVersion: '20.1.0' } }).nodeVersion, '20.1.0');
  assert.equal(readPackaging({ packaging: { nodeVersion: '20.1.0' } }, '24.0.0').nodeVersion, '24.0.0');
});

test('resources plan follows desktop.config.json', () => {
  const target = resolveTarget('darwin-arm64');
  const extra = normalizeExtraResources(['engine']);
  const steps = planResources({ desktopConfig: { resources: { marker: 'back/dist/main.js', frontDir: 'web/dist' } }, target, nodeVersion: '22.20.0', extraResources: extra, sign: true });
  const kinds = steps.map((s) => s.kind);
  assert.deepEqual(kinds, ['copy', 'copy', 'locales', 'npm', 'native', 'copy', 'node', 'extra', 'check', 'sign']);
  assert.equal(steps.find((s) => s.kind === 'copy' && s.from === 'front/dist').to, 'web/dist');
  assert.equal(steps.find((s) => s.kind === 'node').to, 'runtime/node/node');
  assert.ok(formatPlan(steps).includes('[extra] engine -> engine'));
  const win = planResources({ desktopConfig: {}, target: resolveTarget('win-x64'), nodeVersion: '22.20.0', extraResources: [], sign: true });
  assert.equal(win.find((s) => s.kind === 'node').to, 'runtime/node/node.exe');
  assert.ok(!win.some((s) => s.kind === 'sign'));
  assert.deepEqual(resourceTopDirs({ resources: { frontDir: 'web/dist' } }, extra), ['back', 'engine', 'runtime', 'web']);
});

test('locale file filter and collection (symlinks followed)', () => {
  assert.ok(isLocaleFile('src/modules/a/locales/fr.json'));
  assert.ok(!isLocaleFile('src/modules/a/locales/fr.txt'));
  assert.ok(!isLocaleFile('src/modules/a/data/fr.json'));
  const root = tmp();
  put(root, 'src/locales/common.fr.json');
  put(root, 'src/modules/m1/locales/fr.json');
  put(root, 'src/modules/m1/service.ts', '');
  put(root, '../shared-lib/voice/locales/en.json');
  mkdirSync(path.join(root, 'src/modules_shared'), { recursive: true });
  symlinkSync(path.join(root, '../shared-lib/voice'), path.join(root, 'src/modules_shared/voice'));
  assert.deepEqual(findLocaleFiles(root), [
    'src/locales/common.fr.json', 'src/modules/m1/locales/fr.json', 'src/modules_shared/voice/locales/en.json',
  ]);
  assert.deepEqual(findLocaleFiles(tmp()), []);
});

const MACHO_ARM = Buffer.from('cffaedfe0c000001', 'hex');
const MACHO_X64 = Buffer.from('cffaedfe07000001', 'hex');
const ELF_X64 = Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.alloc(14), Buffer.from('3e00', 'hex')]);
const PE = Buffer.from('4d5a9000', 'hex');

test('native binary format detection', () => {
  assert.deepEqual(nativeInfo(MACHO_ARM), { format: 'macho', arch: 'arm64' });
  assert.deepEqual(nativeInfo(MACHO_X64), { format: 'macho', arch: 'x64' });
  assert.deepEqual(nativeInfo(ELF_X64), { format: 'elf', arch: 'x64' });
  assert.deepEqual(nativeInfo(PE), { format: 'pe', arch: null });
  assert.deepEqual(nativeInfo(Buffer.from('hello')), { format: null, arch: null });
});

test('native module detection and classification', () => {
  const root = tmp();
  put(root, 'better-sqlite3/build/Release/better_sqlite3.node', '');
  put(root, '@img/sharp-linux-x64/lib/sharp.node', '');
  put(root, 'lodash/index.js', '');
  const natives = findNativeModules(root);
  assert.deepEqual(natives.map((n) => n.pkg), ['@img/sharp-linux-x64', 'better-sqlite3']);
  const reads = { 'better-sqlite3/build/Release/better_sqlite3.node': MACHO_ARM, '@img/sharp-linux-x64/lib/sharp.node': ELF_X64 };
  const target = resolveTarget('darwin-arm64');
  const classified = classifyNativeModules(natives, target, (f) => reads[f]);
  assert.deepEqual(classified.map((c) => [c.pkg, c.status]), [['@img/sharp-linux-x64', 'mismatch'], ['better-sqlite3', 'handled']]);
  const warnings = nativeWarnings(classified, target);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sharp/);
  const other = classifyNativeModules([{ pkg: 'canvas', file: 'canvas/a.node' }], target, () => MACHO_ARM);
  assert.equal(other[0].status, 'unverified');
  assert.equal(classifyNativeModules(natives.slice(1), resolveTarget('darwin-x64'), (f) => reads[f])[0].status, 'mismatch');
  assert.equal(packageOfPath('a/node_modules/@s/p/x.node'), '@s/p');
});

test('Tauri override maps resources with absolute sources and ad hoc signing', () => {
  const target = resolveTarget('darwin-arm64');
  const o = tauriConfigOverride({ resourcesDir: '/r', desktopConfig: {}, extraResources: normalizeExtraResources(['engine']), target, sign: true });
  assert.deepEqual(o.bundle.resources, { '/r/back': 'back', '/r/engine': 'engine', '/r/front': 'front', '/r/runtime': 'runtime' });
  assert.equal(o.bundle.macOS.signingIdentity, '-');
  assert.equal(tauriConfigOverride({ resourcesDir: '/r', desktopConfig: {}, extraResources: [], target, sign: false }).bundle.macOS, undefined);
  assert.equal(defaultBundles(resolveTarget('win-x64')), 'nsis');
});

test('argument parsing', () => {
  assert.deepEqual(parseArgs(['--target', 'win-x64', '--dry-run']), { target: 'win-x64', 'dry-run': true });
  assert.throws(() => parseArgs(['--target']), /needs a value/);
  assert.throws(() => parseArgs(['oops']), /Unexpected/);
});

test('package names, launcher, readme and layout', () => {
  const win = resolveTarget('win-x64');
  const linux = resolveTarget('linux-x64');
  assert.equal(slugify(' My App! '), 'My-App');
  assert.equal(packageBaseName('My App', '1.2.0', win), 'My-App-1.2.0-win-x64');
  assert.equal(archiveExtension(win), 'zip');
  assert.equal(archiveExtension(linux), 'tar.gz');
  assert.equal(dmgName('My App', '1.2.0', resolveTarget('darwin-arm64')), 'My App_1.2.0_aarch64.dmg');
  assert.equal(dmgName('My App', '1.2.0', resolveTarget('darwin-x64')), 'My App_1.2.0_x64.dmg');
  assert.match(linuxLauncher('shell'), /exec \.\/shell "\$@"/);
  assert.match(portableReadme('My App', '1.2.0', win, dataHint(win, 'a.b')), /SmartScreen/);
  assert.equal(dataHint(linux, 'a.b'), '~/.local/share/a.b');
  const names = archiveLayout('My App', linux, ['back', 'runtime']).map((e) => e.name);
  assert.deepEqual(names, ['desktop-shell', 'launch.sh', 'README.txt', 'back', 'runtime']);
  assert.ok(archiveLayout('My App', win, []).some((e) => e.name === 'My App.exe'));
});
