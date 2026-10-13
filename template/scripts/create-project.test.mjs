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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { answersFromCli, parseCli } from './create-project.mjs';
import { makeLibs } from './lib/fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const GIT_ENV = { GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci@example.com', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@example.com' };

const wizard = (script, args, privateDir) => spawnSync('node', [path.join(HERE, script), ...args], {
  encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...(privateDir ? { VX_PRIVATE_DIR: privateDir } : {}) },
});
const create = (parent, args, privateDir) => wizard('create-project.mjs', [
  '--vendor-libs', '--no-install', '--no-github', '--no-commit', '--public-dir', REPO, '--parent-dir', parent, ...args,
], privateDir);
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const COMMON = ['--yes', '--name', 'demo', '--site-name', 'Demo', '--entity', 'Acme', '--email', 'a@b.co'];

test('CLI parsing: flags, repeatable --answer, aliases', () => {
  const opts = parseCli(['--with-private', '--with-users', '--answer', 'a=1', '--answer=b=x,y', '--modules', 'voice,llm', 'my-app']);
  assert.deepEqual(opts.answer, ['a=1', 'b=x,y']);
  assert.deepEqual(answersFromCli(opts), { projectName: 'my-app', privateAccess: true, multiUser: true, modules: ['voice', 'llm'] });
  assert.throws(() => parseCli(['--name']), /needs a value/);
});

test('anonymous project: --yes, no question, generated configuration, replayable', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'cp-'));
  const r = create(parent, [...COMMON, '--no-private', '--modules', 'voice', '--langs', 'en']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const app = path.join(parent, 'demo');
  assert.deepEqual(json(path.join(app, 'shared-modules.json')).nestcommon, ['common', 'database', 'voice']);
  assert.deepEqual(json(path.join(app, 'shared-modules.json')).reactcommon, ['common', 'voice']);
  const back = readFileSync(path.join(app, 'back', '.env.dev'), 'utf8');
  assert.match(back, /^ADMIN_TOKEN=[0-9a-f]{64}$/m, 'anonymous mode generates ADMIN_TOKEN');
  assert.match(back, /^NODE_PORT=3000$/m);
  assert.doesNotMatch(readFileSync(path.join(app, 'back', '.env.example'), 'utf8'), /JWT_SECRET|@module/);
  assert.doesNotMatch(readFileSync(path.join(app, 'front', '.env.example'), 'utf8'), /REOWN/);
  assert.match(readFileSync(path.join(app, 'back', 'src', 'config', 'defaultConfig.ts'), 'utf8'), /name: 'localesLanguages', value: 'en'/);
  assert.deepEqual(readdirSync(path.join(app, 'back', 'src', 'locales')).sort(), ['custom.en.json']);
  assert.equal(existsSync(path.join(app, 'back', 'src', 'modules_shared', 'voice')), true, 'link-shared ran');
  assert.equal(json(path.join(app, 'project.config.json')).resolved.nest.join(), 'common,database,voice');

  // replay: the saved answers recreate the same selection with another name
  const replay = create(parent, ['--yes', '--answers', path.join(app, 'project.config.json'), '--name', 'demo2']);
  assert.equal(replay.status, 0, replay.stderr + replay.stdout);
  assert.deepEqual(json(path.join(parent, 'demo2', 'shared-modules.json')).nestcommon, ['common', 'database', 'voice']);

  // add-module / remove
  const add = wizard('add-module.mjs', ['--root', app, '--no-install', 'voice']);
  assert.equal(add.status, 0, add.stderr + add.stdout);
  const priv = wizard('add-module.mjs', ['--root', app, '--no-install', '--remove', 'common']);
  assert.match(priv.stderr, /base module/);
  const unknown = wizard('add-module.mjs', ['--root', app, '--no-install', 'llm']);
  assert.notEqual(unknown.status, 0);
  const rm = wizard('add-module.mjs', ['--root', app, '--no-install', '--remove', 'voice']);
  assert.equal(rm.status, 0, rm.stderr + rm.stdout);
  assert.deepEqual(json(path.join(app, 'shared-modules.json')).nestcommon, ['common', 'database']);
  rmSync(parent, { recursive: true, force: true });
});

test('multi-user project with fixture private libs: closure, questions, config, no ADMIN_TOKEN', () => {
  const libs = makeLibs();
  const parent = mkdtempSync(path.join(tmpdir(), 'cp-'));
  const answersFile = path.join(parent, 'answers.json');
  writeFileSync(answersFile, JSON.stringify({
    projectName: 'shop', siteName: 'Shop', entityName: 'Acme', contactEmail: 'a@b.co', privateAccess: true, multiUser: true,
    modules: ['llm'], database: { engine: 'neon', redis: true }, languages: ['fr', 'en'],
    questions: { authMethods: ['wallet', 'email'], registration: 'invitation', multiTenant: false, commerce: true, reownProjectId: 'rp-123' },
  }));
  const r = create(parent, ['--answers', answersFile], libs.priv);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const app = path.join(parent, 'shop');
  assert.deepEqual(json(path.join(app, 'shared-modules.json')).nestcommon, ['common', 'database', 'commerce', 'infra', 'llm', 'user']);
  const back = readFileSync(path.join(app, 'back', '.env.dev'), 'utf8');
  assert.doesNotMatch(back, /^ADMIN_TOKEN=/m);
  assert.match(back, /^DATABASE_ENGINE=neon$/m);
  assert.match(back, /^REDIS_URL=redis:\/\/localhost:6379$/m);
  assert.match(back, /JWT_SECRET/, 'user block active');
  assert.match(readFileSync(path.join(app, 'front', '.env.dev'), 'utf8'), /^VITE_REOWN_PROJECT_ID=rp-123$/m);
  const config = readFileSync(path.join(app, 'back', 'src', 'config', 'defaultConfig.ts'), 'utf8');
  assert.match(config, /user_registrationMode', value: 'invite-only'/);
  assert.match(config, /name: 'features', value: '\{"commerce":\{"enabled":true\}\}'/);
  assert.equal(existsSync(path.join(app, 'back', '.libs', 'vx-private', 'nest', 'user', 'module.json')), true);
  libs.cleanup();
  rmSync(parent, { recursive: true, force: true });
});

test('multi-user project without selling nor infra links only user (+ common, database)', () => {
  const libs = makeLibs();
  const parent = mkdtempSync(path.join(tmpdir(), 'cp-'));
  const answersFile = path.join(parent, 'answers.json');
  writeFileSync(answersFile, JSON.stringify({
    projectName: 'lite', siteName: 'Lite', entityName: 'Acme', contactEmail: 'a@b.co', privateAccess: true, multiUser: true,
    languages: ['en'], questions: { authMethods: ['email'], registration: 'open', commerce: false, infra: false },
  }));
  const r = create(parent, ['--answers', answersFile], libs.priv);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const app = path.join(parent, 'lite');
  const shared = json(path.join(app, 'shared-modules.json'));
  assert.deepEqual(shared.nestcommon, ['common', 'database', 'user']);
  assert.deepEqual(shared.reactcommon, ['common', 'user']);
  const config = readFileSync(path.join(app, 'back', 'src', 'config', 'defaultConfig.ts'), 'utf8');
  assert.match(config, /name: 'features', value: '\{"commerce":\{"enabled":false\}\}'/);
  libs.cleanup();
  rmSync(parent, { recursive: true, force: true });
});

test('incoherent answers are refused (exit 2) and --dry-run writes nothing', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'cp-'));
  const bad = create(parent, [...COMMON, '--no-private', '--multi-user']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /multiUser requires privateAccess/);
  const dry = create(parent, [...COMMON, '--no-private', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Back modules\s+common, database/);
  assert.deepEqual(readdirSync(parent), []);
  const noName = create(parent, ['--yes', '--no-private']);
  assert.notEqual(noName.status, 0);
  rmSync(parent, { recursive: true, force: true });
});
