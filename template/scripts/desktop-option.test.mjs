/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { answersFromCli, parseCli, renderPlan } from './create-project.mjs';
import { desktopFiles, installDesktop, planDesktopInstall } from './lib/desktop-install.mjs';
import { makeLibs } from './lib/fixtures.mjs';
import {
  DESKTOP_IDENTIFIER, buildDesktopConfig, loadCatalog, resolveDesktop, validateAnswers, validateDesktop, withDesktopScripts,
} from './lib/project-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(HERE, '..');
const REPO = path.resolve(TEMPLATE, '..');
const node = (script, args, env = {}) => spawnSync('node', [path.join(HERE, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const create = (parent, args, privateDir) => node('create-project.mjs', [
  '--vendor-libs', '--no-install', '--no-github', '--no-commit', '--public-dir', REPO, '--parent-dir', parent, ...args,
], privateDir ? { VX_PRIVATE_DIR: privateDir } : {});
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const COMMON = ['--yes', '--name', 'demo', '--site-name', 'Demo', '--entity', 'Acme', '--email', 'a@b.co', '--no-private'];
const base = { projectName: 'demo', siteName: 'Demo', entityName: 'Acme', contactEmail: 'a@b.co', database: { engine: 'sqlite' } };

/** Fake existing project (no libraries mounted, no git): enough for add-desktop. */
function fakeProject(parent, { engine = 'sqlite', modules = ['common', 'database'], config = {} } = {}) {
  const root = path.join(parent, `proj-${readdirSync(parent).length}`);
  mkdirSync(path.join(root, 'back'), { recursive: true });
  writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ ...base, database: { engine }, ...config }));
  writeFileSync(path.join(root, 'shared-modules.json'), JSON.stringify({ nestcommon: modules, reactcommon: modules.filter((m) => m !== 'database') }));
  writeFileSync(path.join(root, 'back', 'package.local.json'), JSON.stringify({ name: 'demo-back', version: '0.1.0', scripts: { lint: 'x' } }));
  return root;
}

test('CLI: --desktop flags map to the desktop section', () => {
  assert.deepEqual(answersFromCli(parseCli(['--desktop', '--desktop-name', 'My Demo', '--desktop-identifier=org.acme.demo', 'app'])),
    { projectName: 'app', desktop: { enabled: true, productName: 'My Demo', identifier: 'org.acme.demo' } });
  assert.deepEqual(answersFromCli(parseCli(['--no-desktop'])), { desktop: { enabled: false } });
});

test('resolveDesktop: defaults, explicit values, identifier format', () => {
  assert.deepEqual(resolveDesktop({ ...base, desktop: { enabled: true } }),
    { enabled: true, productName: 'Demo', identifier: 'com.example.demo', sidecars: [] });
  assert.equal(resolveDesktop({ projectName: 'my-notes', desktop: { enabled: true } }).identifier, 'com.example.mynotes');
  assert.equal(resolveDesktop({ ...base, desktop: { enabled: true, productName: 'X', identifier: 'org.a.b' } }).identifier, 'org.a.b');
  for (const ok of ['com.example.app', 'io.github.acme.my-app', 'org.a1']) assert.match(ok, DESKTOP_IDENTIFIER);
  for (const bad of ['app', 'com..app', '.com.app', 'com.app.', 'com.my app', '1com.app', 'com.app_x']) assert.doesNotMatch(bad, DESKTOP_IDENTIFIER);
});

test('validateDesktop: nothing when off; identifier, engine, user module and sidecars checked when on', () => {
  assert.deepEqual(validateDesktop({ ...base, desktop: { enabled: false, identifier: 'bad' } }, ['common']), []);
  assert.deepEqual(validateDesktop({ ...base, desktop: { enabled: true } }, ['common', 'database']), []);
  const msg = (a, ids = ['common']) => validateDesktop(a, ids).join(' | ');
  assert.match(msg({ ...base, desktop: { enabled: true, identifier: 'nodot' } }), /reverse-domain/);
  assert.match(msg({ ...base, database: { engine: 'neon' }, desktop: { enabled: true } }), /requires the sqlite database engine/);
  assert.match(msg({ ...base, desktop: { enabled: true } }, ['common', 'user']), /without the user module/);
  assert.match(msg({ ...base, desktop: { enabled: true, sidecars: [{ name: 'server' }] } }), /reserved or duplicated/);
  assert.match(msg({ ...base, desktop: { enabled: true, sidecars: [{ name: 'e' }, { name: 'e' }] } }), /reserved or duplicated/);
  assert.match(msg({ ...base, desktop: { enabled: true, sidecars: [{}] } }), /needs a "name"/);
});

test('validateAnswers integrates the desktop check (fixture libraries: user refused)', () => {
  const libs = makeLibs();
  const catalog = loadCatalog({ public: libs.pub, private: libs.priv });
  assert.deepEqual(validateAnswers({ ...base, desktop: { enabled: true } }, catalog), []);
  const errors = validateAnswers({ ...base, privateAccess: true, multiUser: true, database: { engine: 'neon' }, desktop: { enabled: true } }, catalog).join(' | ');
  assert.match(errors, /desktop option only applies to applications without the user module/);
  libs.cleanup();
});

test('buildDesktopConfig fills identity and sidecars, keeps the rest; withDesktopScripts keeps existing scripts', () => {
  const template = json(path.join(TEMPLATE, 'desktop', 'desktop.config.json'));
  const config = buildDesktopConfig(template, { ...base, desktop: { enabled: true, identifier: 'org.acme.demo', sidecars: [{ name: 'engine', command: 'x' }] } });
  assert.equal(config.productName, 'Demo');
  assert.equal(config.identifier, 'org.acme.demo');
  assert.deepEqual(config.sidecars, [{ name: 'engine', command: 'x' }]);
  assert.deepEqual(config.server, template.server);
  const pkg = withDesktopScripts({ name: 'a', scripts: { 'desktop:dev': 'mine', lint: 'x' } });
  assert.equal(pkg.scripts['desktop:dev'], 'mine');
  assert.match(pkg.scripts['desktop:build'], /build-desktop\.mjs --root \.\. --bundle/);
});

test('desktopFiles: the shell and the workflow, no build output', () => {
  const files = desktopFiles(TEMPLATE).map((f) => f.to.split(path.sep).join('/'));
  for (const expected of ['desktop/desktop.config.json', 'desktop/package.json', 'desktop/src-tauri/Cargo.toml', 'desktop/splash/index.html', '.github/workflows/build-desktop.yml']) {
    assert.ok(files.includes(expected), expected);
  }
  assert.equal(files.filter((f) => /node_modules|\/target\/|\/build\/|src-tauri\/gen/.test(f)).length, 0);
});

test('--dry-run without desktop: no desktop line content, with desktop: sqlite proposed, plan line, nothing written', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dk-'));
  const off = create(parent, [...COMMON, '--dry-run']);
  assert.equal(off.status, 0, off.stderr + off.stdout);
  assert.match(off.stdout, /Desktop\s+no\n/);
  const on = create(parent, [...COMMON, '--desktop', '--dry-run']);
  assert.equal(on.status, 0, on.stderr + on.stdout);
  assert.match(on.stdout, /Desktop\s+yes \("Demo", com\.example\.demo;/);
  assert.match(on.stdout, /Database\s+sqlite/, 'sqlite is the default with the desktop option');
  const custom = create(parent, [...COMMON, '--desktop', '--desktop-name', 'Demo Studio', '--desktop-identifier', 'org.acme.demo', '--dry-run']);
  assert.match(custom.stdout, /"Demo Studio", org\.acme\.demo/);
  assert.deepEqual(readdirSync(parent), []);
  rmSync(parent, { recursive: true, force: true });
});

test('--dry-run refuses a bad identifier, another database, and the user module', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dk-'));
  const id = create(parent, [...COMMON, '--desktop', '--desktop-identifier', 'nodot', '--dry-run']);
  assert.equal(id.status, 2);
  assert.match(id.stderr, /reverse-domain/);
  const db = create(parent, [...COMMON, '--desktop', '--db', 'neon', '--dry-run']);
  assert.equal(db.status, 2);
  assert.match(db.stderr, /requires the sqlite database engine/);
  const libs = makeLibs();
  const user = create(parent, ['--yes', '--name', 'demo', '--private', '--multi-user', '--desktop', '--db', 'neon', '--dry-run'], libs.priv);
  assert.equal(user.status, 2);
  assert.match(user.stderr, /desktop option only applies to applications without the user module/);
  libs.cleanup();
  assert.deepEqual(readdirSync(parent), []);
  rmSync(parent, { recursive: true, force: true });
});

test('renderPlan: desktop line (pure)', () => {
  const answers = { ...base, languages: ['en'], privateAccess: false, ports: { back: 3000, front: 5173 }, desktop: { enabled: true } };
  const plan = renderPlan(answers, { ids: ['common'], perStack: { nest: [], react: [] }, added: [] }, { byId: new Map(), byStack: {} }, '/x');
  assert.match(plan, /Desktop\s+yes \("Demo", com\.example\.demo/);
});

test('create-project --desktop: shell copied, desktop.config.json and project.config.json filled, scripts added', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dk-'));
  const r = create(parent, [...COMMON, '--desktop', '--desktop-name', 'Demo Studio', '--desktop-identifier', 'org.acme.demo', '--langs', 'en']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const app = path.join(parent, 'demo');
  assert.deepEqual(json(path.join(app, 'project.config.json')).desktop, { enabled: true, productName: 'Demo Studio', identifier: 'org.acme.demo', sidecars: [] });
  const config = json(path.join(app, 'desktop', 'desktop.config.json'));
  assert.equal(config.productName, 'Demo Studio');
  assert.equal(config.identifier, 'org.acme.demo');
  assert.equal(existsSync(path.join(app, 'desktop', 'src-tauri', 'Cargo.toml')), true);
  const tauri = json(path.join(app, 'desktop', 'src-tauri', 'tauri.conf.json'));
  assert.deepEqual([tauri.productName, tauri.identifier], ['Demo Studio', 'org.acme.demo'], 'tauri.conf.json synced');
  assert.equal(existsSync(path.join(app, '.github', 'workflows', 'build-desktop.yml')), true);
  const local = json(path.join(app, 'back', 'package.local.json'));
  assert.ok(local.scripts['desktop:dev'] && local.scripts['desktop:build']);
  assert.equal(local.dependencies['better-sqlite3'] !== undefined, true);
  assert.match(readFileSync(path.join(app, 'back', '.env.dev'), 'utf8'), /^DATABASE_ENGINE=sqlite$/m);
  assert.ok(json(path.join(app, 'back', 'package.json')).scripts['desktop:build'], 'generated back/package.json carries the scripts');
  // without the option: no desktop files, nothing in package.local.json
  const plain = create(parent, [...COMMON, '--name', 'plain', '--no-desktop', '--db', 'sqlite']);
  assert.equal(plain.status, 0, plain.stderr + plain.stdout);
  assert.equal(existsSync(path.join(parent, 'plain', 'desktop')), false);
  assert.equal(existsSync(path.join(parent, 'plain', '.github')), false);
  assert.deepEqual(json(path.join(parent, 'plain', 'project.config.json')).desktop, { enabled: false });
  assert.equal(json(path.join(parent, 'plain', 'back', 'package.local.json')).scripts, undefined);
  rmSync(parent, { recursive: true, force: true });
});

test('add-desktop: --dry-run writes nothing; real run copies, configures, refuses a second run', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dk-'));
  const root = fakeProject(parent);
  const dry = node('add-desktop.mjs', ['--root', root, '--identifier', 'org.acme.demo', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.match(dry.stdout, /Demo" \(org\.acme\.demo\)/);
  assert.equal(existsSync(path.join(root, 'desktop')), false);
  assert.equal(json(path.join(root, 'project.config.json')).desktop, undefined);

  const run = node('add-desktop.mjs', ['--root', root, '--name', 'Demo Studio', '--identifier', 'org.acme.demo']);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.deepEqual(json(path.join(root, 'project.config.json')).desktop, { enabled: true, productName: 'Demo Studio', identifier: 'org.acme.demo', sidecars: [] });
  assert.equal(json(path.join(root, 'desktop', 'desktop.config.json')).identifier, 'org.acme.demo');
  assert.equal(existsSync(path.join(root, '.github', 'workflows', 'build-desktop.yml')), true);
  const local = json(path.join(root, 'back', 'package.local.json'));
  assert.equal(local.scripts.lint, 'x', 'existing scripts kept');
  assert.ok(local.scripts['desktop:dev'] && local.scripts['desktop:build']);

  const again = node('add-desktop.mjs', ['--root', root]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /already enabled/);
  rmSync(parent, { recursive: true, force: true });
});

test('add-desktop overwrites nothing: existing desktop/ or workflow refuses; installDesktop throws on a clash', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dk-'));
  const root = fakeProject(parent);
  mkdirSync(path.join(root, 'desktop'));
  writeFileSync(path.join(root, 'desktop', 'mine.txt'), 'keep');
  const refused = node('add-desktop.mjs', ['--root', root]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /desktop\/ already exists/);
  assert.equal(readFileSync(path.join(root, 'desktop', 'mine.txt'), 'utf8'), 'keep');
  assert.deepEqual(planDesktopInstall(root, TEMPLATE).conflicts, ['desktop/']);
  assert.throws(() => installDesktop(root, TEMPLATE, { ...base, desktop: { enabled: true } }), /already exists/);
  assert.equal(readFileSync(path.join(root, 'desktop', 'mine.txt'), 'utf8'), 'keep');

  const root2 = fakeProject(parent);
  mkdirSync(path.join(root2, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(root2, '.github', 'workflows', 'build-desktop.yml'), 'mine');
  const wf = node('add-desktop.mjs', ['--root', root2]);
  assert.equal(wf.status, 2);
  assert.match(wf.stderr, /build-desktop\.yml already exists/);
  assert.equal(existsSync(path.join(root2, 'desktop')), false);
  rmSync(parent, { recursive: true, force: true });
});

test('add-desktop refuses the user module, another database, a bad identifier, and a non-project', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dk-'));
  const withUser = node('add-desktop.mjs', ['--root', fakeProject(parent, { modules: ['common', 'database', 'user'] }), '--dry-run']);
  assert.equal(withUser.status, 2);
  assert.match(withUser.stderr, /without the user module/);
  const pg = node('add-desktop.mjs', ['--root', fakeProject(parent, { engine: 'selfhosted' }), '--dry-run']);
  assert.equal(pg.status, 2);
  assert.match(pg.stderr, /requires the sqlite database engine/);
  const bad = node('add-desktop.mjs', ['--root', fakeProject(parent), '--identifier', 'nodot', '--dry-run']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /reverse-domain/);
  const none = node('add-desktop.mjs', ['--root', parent]);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /not a project created by create-project/);
  assert.notEqual(node('add-desktop.mjs', ['--bogus']).status, 0);
  rmSync(parent, { recursive: true, force: true });
});
