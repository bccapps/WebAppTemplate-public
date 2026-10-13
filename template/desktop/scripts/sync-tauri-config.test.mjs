/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectVersion, resolveVersion, setCargoVersion, syncTauriConf } from './sync-tauri-config.mjs';

test('syncTauriConf copies identity and keeps the rest', () => {
  const out = syncTauriConf({ productName: 'A', identifier: 'x.y' }, { productName: 'B', identifier: 'z', bundle: { active: true } });
  assert.deepEqual(out, { productName: 'A', identifier: 'x.y', bundle: { active: true } });
});

test('syncTauriConf sets the version only when given', () => {
  const base = { version: '0.1.0' };
  assert.equal(syncTauriConf({ productName: 'A', identifier: 'x' }, base).version, '0.1.0');
  assert.equal(syncTauriConf({ productName: 'A', identifier: 'x' }, base, '2.0.0').version, '2.0.0');
});

test('setCargoVersion rewrites the package version only', () => {
  const toml = '[package]\nname = "a"\nversion = "0.1.0"\n\n[dependencies]\nfoo = { version = "1" }\n';
  assert.equal(setCargoVersion(toml, '1.2.3'), '[package]\nname = "a"\nversion = "1.2.3"\n\n[dependencies]\nfoo = { version = "1" }\n');
});

test('shipped desktop.config.json and tauri.conf.json agree', () => {
  const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
  const cfg = read('../desktop.config.json');
  const conf = read('../src-tauri/tauri.conf.json');
  assert.equal(conf.productName, cfg.productName);
  assert.equal(conf.identifier, cfg.identifier);
});

test('resolveVersion: cli, then project.config.json, then back/package.json', () => {
  const projectConfig = { version: '2.0.0' };
  const backPackage = { version: '3.0.0' };
  assert.equal(resolveVersion({ cli: '1.0.0', projectConfig, backPackage }), '1.0.0');
  assert.equal(resolveVersion({ projectConfig, backPackage }), '2.0.0');
  assert.equal(resolveVersion({ projectConfig: {}, backPackage }), '3.0.0');
  assert.equal(resolveVersion({}), undefined);
  assert.throws(() => resolveVersion({ cli: 'v1' }), /Invalid version/);
});

test('projectVersion reads the project files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ver-'));
  mkdirSync(path.join(root, 'back'));
  assert.equal(projectVersion(root), undefined);
  writeFileSync(path.join(root, 'back', 'package.json'), '{"version":"0.4.0"}');
  assert.equal(projectVersion(root), '0.4.0');
  writeFileSync(path.join(root, 'project.config.json'), '{"version":"1.5.0"}');
  assert.equal(projectVersion(root), '1.5.0');
  assert.equal(projectVersion(root, '9.9.9'), '9.9.9');
});
