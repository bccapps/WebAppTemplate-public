/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkVariantModules, isExcludedFromStage, mergeDeep, normalizeVariant, readProjectVariant, resolveVariant, stageVariant, variantFromFlag, variantProblems,
} from './variant.mjs';

const MANIFESTS = {
  common: { id: 'common', requires: [] },
  user: { id: 'user', databases: ['postgres'], requires: ['common'] },
  'llm-client': { id: 'llm-client', databases: ['postgres'], requires: ['oauth', 'user'] },
  oauth: { id: 'oauth', requires: [] },
  database: { id: 'database', requires: [] },
};
const reader = (_stack, id) => MANIFESTS[id] ?? null;

function tmp() { return mkdtempSync(path.join(tmpdir(), 'variant-')); }
function put(root, rel, content = '') {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}
function tree(dir, base = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(path.join(dir, e.name), path.join(base, e.name)) : [path.join(base, e.name)])).sort();
}

test('normalizeVariant accepts the string shorthand and the full form, and rejects paths leaving the project', () => {
  assert.equal(normalizeVariant(undefined), null);
  assert.deepEqual(normalizeVariant('shared-modules.desktop.json'), { sharedModules: 'shared-modules.desktop.json', packageLocal: {}, prune: [] });
  assert.deepEqual(normalizeVariant({ sharedModules: 'a/b.json', packageLocal: { back: 'back/x.json' }, prune: ['back/src/x'] }), {
    sharedModules: 'a/b.json', packageLocal: { back: 'back/x.json' }, prune: ['back/src/x'],
  });
  assert.deepEqual(normalizeVariant({ descriptor: 'desktop-flavor.json' }), { packageLocal: {}, prune: [], descriptor: 'desktop-flavor.json' });
  assert.throws(() => normalizeVariant({ sharedModules: 'a.json', prune: ['../x'] }), /inside the project/);
  assert.throws(() => normalizeVariant({ sharedModules: 'a.json', prune: 'x' }), /list of paths/);
  assert.throws(() => normalizeVariant({ sharedModules: '../x.json' }), /inside the project/);
  assert.throws(() => normalizeVariant({ sharedModules: '/etc/x.json' }), /inside the project/);
  assert.throws(() => normalizeVariant({ sharedModules: 'a.json', packageLocal: { api: 'x.json' } }), /unknown stack/);
  assert.throws(() => normalizeVariant({}), /needs a "sharedModules" path/);
  assert.throws(() => normalizeVariant(42), /object/);
});

test('a variant without the user module and with SQLite-capable modules is accepted', () => {
  assert.deepEqual(checkVariantModules({ nestcommon: ['common', 'database'], reactcommon: ['common'] }, reader), []);
});

test('the user module, a Postgres-only module and a missing requirement are refused', () => {
  const errors = checkVariantModules({ nestcommon: ['common', 'user'], reactcommon: ['common'] }, reader);
  assert.ok(errors.some((e) => /"user" module/.test(e)));
  assert.ok(errors.some((e) => /module "user".*does not support SQLite/.test(e)));
  const llm = checkVariantModules({ nestcommon: ['common', 'llm-client'], reactcommon: ['common'] }, reader);
  assert.ok(llm.some((e) => /"llm-client".*requires "user"/.test(e)));
  assert.ok(llm.some((e) => /"llm-client".*requires "oauth"/.test(e)));
});

test('a variant needs a back module list; unknown modules are left to the build', () => {
  assert.ok(checkVariantModules({ reactcommon: ['common'] }, reader).some((e) => /no "nestcommon" list/.test(e)));
  assert.deepEqual(checkVariantModules({ nestcommon: ['mystery'], reactcommon: [] }, reader), []);
});

test('mergeDeep merges objects and replaces arrays and scalars', () => {
  const merged = mergeDeep({ a: 1, dependencies: { x: '1', y: '1' }, list: [1, 2] }, { dependencies: { y: '2', z: '3' }, list: [9], b: true });
  assert.deepEqual(merged, { a: 1, dependencies: { x: '1', y: '2', z: '3' }, list: [9], b: true });
});

test('what must not travel into the stage is excluded', () => {
  for (const name of ['node_modules', 'dist', '.git', '.libs', '.env', '.env.dev', 'package.json', 'package-lock.json', 'app.log', 'x.tgz']) assert.equal(isExcludedFromStage(name), true, name);
  for (const name of ['src', 'tsconfig.json', 'package.local.json', 'test', 'README.md']) assert.equal(isExcludedFromStage(name), false, name);
});

/** A project with a back + front, mounted libs (stub build-package), a variant file and developer-only files. */
function fixture({ variantModules = { nestcommon: ['common', 'database'], reactcommon: ['common'] } } = {}) {
  const root = tmp();
  put(root, 'project.config.json', JSON.stringify({ desktop: { enabled: true, variant: { sharedModules: 'shared-modules.desktop.json', packageLocal: { back: 'back/package.local.desktop.json' } } } }));
  put(root, 'shared-modules.json', JSON.stringify({ nestcommon: ['common', 'user', 'database'], reactcommon: ['common', 'user'] }));
  put(root, 'shared-modules.desktop.json', JSON.stringify(variantModules));
  for (const stack of ['back', 'front']) {
    put(root, `${stack}/src/main.ts`, 'main');
    put(root, `${stack}/.env`, 'SECRET=1');
    put(root, `${stack}/.env.dev`, 'SECRET=2');
    put(root, `${stack}/package.json`, '{"dev":true}');
    put(root, `${stack}/node_modules/dep/index.js`, '');
    put(root, `${stack}/dist/old.js`, '');
    put(root, `${stack}/package.local.json`, JSON.stringify({ dependencies: { pg: '1' }, name: stack }));
    const kind = stack === 'back' ? 'nest' : 'react';
    for (const id of ['common', 'database', 'user']) put(root, `${stack}/.libs/vx-public/${kind}/${id}/module.json`, JSON.stringify(MANIFESTS[id] ?? { id }));
    put(root, `${stack}/.libs/vx-public/template/scripts/build-package.mjs`, "import { writeFileSync } from 'node:fs'; writeFileSync('package.json', JSON.stringify({ generated: true, stack: process.argv[2] }));");
    symlinkSync('vx-public/template', path.join(root, stack, '.libs', 'apptemplate'));
    mkdirSync(path.join(root, stack, 'src', 'modules_shared'), { recursive: true });
    symlinkSync(path.join('..', '..', '.libs', 'vx-public', kind, 'user'), path.join(root, stack, 'src', 'modules_shared', 'user'));
    put(root, `${stack}/src/modules_shared/appmodule/real.ts`, 'app-owned');
  }
  put(root, 'back/package.local.desktop.json', JSON.stringify({ dependencies: { 'better-sqlite3': '^12' } }));
  return root;
}

test('variantProblems reads the project: valid variant, missing file, forbidden module', () => {
  const root = fixture();
  const variant = readProjectVariant(root);
  assert.deepEqual(variantProblems(root, variant), []);
  assert.ok(variantProblems(root, { ...variant, sharedModules: 'nope.json' })[0].includes('does not exist'));
  assert.ok(variantProblems(root, { ...variant, packageLocal: { back: 'missing.json' } })[0].includes('does not exist'));
  const bad = fixture({ variantModules: { nestcommon: ['common', 'user'], reactcommon: ['common'] } });
  assert.ok(variantProblems(bad, readProjectVariant(bad)).some((e) => /"user" module/.test(e)));
});

test('stageVariant builds an isolated copy and leaves the developer tree untouched', () => {
  const root = fixture();
  const before = tree(root).filter((f) => !f.startsWith(path.join('desktop', 'build')));
  const variant = readProjectVariant(root);
  const { stageRoot } = stageVariant(root, variant, { install: false, build: false });
  assert.equal(stageRoot, path.join(root, 'desktop', 'build', 'variant'));

  assert.equal(readFileSync(path.join(stageRoot, 'shared-modules.json'), 'utf8'), readFileSync(path.join(root, 'shared-modules.desktop.json'), 'utf8'));
  for (const stack of ['back', 'front']) {
    assert.equal(readFileSync(path.join(stageRoot, stack, 'src', 'main.ts'), 'utf8'), 'main');
    // developer-only files do not travel
    for (const rel of ['.env', '.env.dev', 'node_modules', 'dist']) assert.equal(existsSync(path.join(stageRoot, stack, rel)), false, `${stack}/${rel}`);
    // the shared-module symlink is not copied (link-shared regenerates it) but an app-owned module is
    assert.equal(existsSync(path.join(stageRoot, stack, 'src', 'modules_shared', 'user')), false);
    assert.equal(readFileSync(path.join(stageRoot, stack, 'src', 'modules_shared', 'appmodule', 'real.ts'), 'utf8'), 'app-owned');
    // libraries are REAL copies (Node resolves dependencies from the real path), apptemplate stays an alias
    assert.equal(lstatSync(path.join(stageRoot, stack, '.libs', 'vx-public')).isSymbolicLink(), false);
    assert.equal(lstatSync(path.join(stageRoot, stack, '.libs', 'apptemplate')).isSymbolicLink(), true);
    // package.json is GENERATED by the stage's own build-package
    assert.deepEqual(JSON.parse(readFileSync(path.join(stageRoot, stack, 'package.json'), 'utf8')), { generated: true, stack });
  }
  const backLocal = JSON.parse(readFileSync(path.join(stageRoot, 'back', 'package.local.json'), 'utf8'));
  assert.deepEqual(backLocal.dependencies, { pg: '1', 'better-sqlite3': '^12' }, 'overlay merged onto the project package.local.json');
  assert.deepEqual(JSON.parse(readFileSync(path.join(stageRoot, 'front', 'package.local.json'), 'utf8')).dependencies, { pg: '1' });

  // the developer's tree is exactly as it was (everything new lives under desktop/build/)
  assert.deepEqual(tree(root).filter((f) => !f.startsWith(path.join('desktop', 'build'))), before);
  assert.equal(readFileSync(path.join(root, 'back', 'package.json'), 'utf8'), '{"dev":true}');
  assert.equal(lstatSync(path.join(root, 'back', 'src', 'modules_shared', 'user')).isSymbolicLink(), true);
});

test('stageVariant refuses an invalid variant before writing anything', () => {
  const root = fixture({ variantModules: { nestcommon: ['common', 'user'], reactcommon: ['common'] } });
  assert.throws(() => stageVariant(root, readProjectVariant(root), { install: false, build: false }), /desktop variant refused/);
  assert.equal(existsSync(path.join(root, 'desktop')), false);
});

test('a second stage keeps node_modules and refreshes sources', () => {
  const root = fixture();
  const variant = readProjectVariant(root);
  const { stageRoot } = stageVariant(root, variant, { install: false, build: false });
  put(stageRoot, 'back/node_modules/kept/index.js', 'x');
  put(root, 'back/src/main.ts', 'changed');
  stageVariant(root, variant, { install: false, build: false });
  assert.equal(readFileSync(path.join(stageRoot, 'back', 'src', 'main.ts'), 'utf8'), 'changed');
  assert.equal(existsSync(path.join(stageRoot, 'back', 'node_modules', 'kept', 'index.js')), true);
});

/** The fixture plus a descriptor file (what AgentHub ships as desktop-flavor.json) instead of a project.config.json variant. */
function flavorFixture() {
  const root = fixture();
  writeFileSync(path.join(root, 'project.config.json'), '{}');
  put(root, 'desktop-flavor.json', JSON.stringify({ _doc: 'x', sharedModules: 'shared-modules.desktop.json', prune: ['back/src/llm'], env: { LOCAL_TRUST: 'true' } }));
  put(root, 'back/src/llm/agent.ts', 'needs llm-client');
  put(root, 'back/src/keep/ok.ts', 'ok');
  return root;
}

test('a descriptor file is found by convention, even without a variant in project.config.json', () => {
  const root = flavorFixture();
  const variant = readProjectVariant(root);
  assert.deepEqual(variant, { packageLocal: {}, prune: [], descriptor: 'desktop-flavor.json' });
  const resolved = resolveVariant(root, variant);
  assert.equal(resolved.sharedModules, 'shared-modules.desktop.json');
  assert.deepEqual(resolved.prune, ['back/src/llm']);
  assert.deepEqual(resolved.env, { LOCAL_TRUST: 'true' });
  assert.deepEqual(variantProblems(root, variant), []);
  assert.equal(readProjectVariant(tmp()), null);
});

test('explicit fields win over the descriptor, prune lists add up, a bad descriptor is reported', () => {
  const root = flavorFixture();
  const resolved = resolveVariant(root, { sharedModules: 'other.json', packageLocal: { back: 'x.json' }, prune: ['front/src/y'], descriptor: 'desktop-flavor.json' });
  assert.equal(resolved.sharedModules, 'other.json');
  assert.deepEqual(resolved.prune.sort(), ['back/src/llm', 'front/src/y']);
  assert.deepEqual(resolved.packageLocal, { back: 'x.json' });
  assert.match(variantProblems(root, { packageLocal: {}, prune: [], descriptor: 'missing.json' })[0], /missing\.json.*does not exist/);
  put(root, 'broken.json', '{ nope');
  assert.match(variantProblems(root, { packageLocal: {}, prune: [], descriptor: 'broken.json' })[0], /broken\.json/);
  assert.ok(variantProblems(root, { sharedModules: 'shared-modules.desktop.json', packageLocal: {}, prune: ['back/src/ghost'] }).some((e) => /ghost.*does not exist/.test(e)));
});

test('variantFromFlag tells a descriptor from a module list', () => {
  const root = flavorFixture();
  assert.deepEqual(variantFromFlag(root, 'desktop-flavor.json'), { descriptor: 'desktop-flavor.json' });
  assert.deepEqual(variantFromFlag(root, 'shared-modules.desktop.json'), { sharedModules: 'shared-modules.desktop.json' });
  assert.deepEqual(variantFromFlag(root, 'not-there.json'), { sharedModules: 'not-there.json' });
});

test('stageVariant prunes the descriptor folders from the STAGED copy only', () => {
  const root = flavorFixture();
  const { stageRoot } = stageVariant(root, readProjectVariant(root), { install: false, build: false });
  assert.equal(existsSync(path.join(stageRoot, 'back', 'src', 'llm')), false);
  assert.equal(readFileSync(path.join(stageRoot, 'back', 'src', 'keep', 'ok.ts'), 'utf8'), 'ok');
  assert.equal(readFileSync(path.join(root, 'back', 'src', 'llm', 'agent.ts'), 'utf8'), 'needs llm-client');
});

test('<stack>/package.local.desktop.json is picked up by convention and merged into the stage', () => {
  const root = fixture();
  put(root, 'front/package.local.desktop.json', JSON.stringify({ dependencies: { '@tanstack/react-query': '^5' } }));
  const variant = readProjectVariant(root);
  const resolved = resolveVariant(root, variant);
  assert.equal(resolved.packageLocal.front, 'front/package.local.desktop.json');
  assert.equal(resolved.packageLocal.back, 'back/package.local.desktop.json', 'a declared overlay is kept');
  const { stageRoot } = stageVariant(root, variant, { install: false, build: false });
  assert.deepEqual(JSON.parse(readFileSync(path.join(stageRoot, 'front', 'package.local.json'), 'utf8')).dependencies, { pg: '1', '@tanstack/react-query': '^5' });
  assert.equal(existsSync(path.join(stageRoot, 'front', 'package.local.desktop.json')), true, 'the overlay file itself is a plain source file in the stage');
});

