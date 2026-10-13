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
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { answersFromCli, backEnvValues, backPackageLocal, parseCli, renderPlan, sqliteDbPath } from './create-project.mjs';
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

test('sqlite: generated back env and package.local.json (pure functions)', () => {
  const answers = { projectName: 'notes', ports: { back: 3000, front: 5173 }, database: { engine: 'sqlite', redis: false } };
  const env = backEnvValues(answers, { ids: ['common', 'database'] }, { back: {}, front: {} });
  assert.equal(env.DATABASE_ENGINE, 'sqlite');
  assert.equal(env.DB_PATH, 'data/notes.db');
  assert.equal(sqliteDbPath('notes'), 'data/notes.db');
  for (const k of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_MIGRATIONS_RUN', 'REDIS_URL']) assert.equal(k in env, false, `${k} must not be written`);
  assert.deepEqual(backPackageLocal(answers), { name: 'notes-back', version: '0.1.0', dependencies: { 'better-sqlite3': '^12.11.1' } });
  const pg = { ...answers, database: { engine: 'selfhosted', redis: true } };
  assert.deepEqual(backPackageLocal(pg), { name: 'notes-back', version: '0.1.0' }, 'no native dependency for Postgres');
  const pgEnv = backEnvValues(pg, { ids: ['common'] }, { back: {}, front: {} });
  assert.equal(pgEnv.DB_HOST, 'localhost');
  assert.equal('DB_PATH' in pgEnv, false);
  assert.equal('DATABASE_ENGINE' in pgEnv, false);
  assert.equal(backEnvValues({ ...answers, database: { engine: 'sqlite', redis: true } }, { ids: [] }, { back: {}, front: {} }).REDIS_URL, 'redis://localhost:6379');
  assert.match(renderPlan({ ...answers, siteName: 'N', languages: ['en'], privateAccess: false }, { ids: ['common'], perStack: { nest: [], react: [] }, added: [] }, { byId: new Map(), byStack: {} }, '/x'), /Database\s+sqlite \(data\/notes.db/);
});

test('local trust: CLI flags, env values only without the user module, plan line', () => {
  assert.deepEqual(answersFromCli(parseCli(['--local-trust', 'app'])), { projectName: 'app', localTrust: true });
  assert.equal(answersFromCli(parseCli(['--no-local-trust'])).localTrust, false);
  const answers = { projectName: 'notes', ports: { back: 3000, front: 5173 }, database: { engine: 'selfhosted', redis: false }, localTrust: true };
  const env = backEnvValues(answers, { ids: ['common', 'database'] }, { back: {}, front: {} });
  assert.equal(env.LOCAL_TRUST, 'true');
  assert.equal(env.HOST, '127.0.0.1');
  const withUser = backEnvValues(answers, { ids: ['common', 'user'] }, { back: {}, front: {} });
  assert.equal('LOCAL_TRUST' in withUser, false, 'no effect with the user module');
  assert.equal('HOST' in withUser, false);
  const off = backEnvValues({ ...answers, localTrust: false }, { ids: ['common'] }, { back: {}, front: {} });
  assert.equal('LOCAL_TRUST' in off, false);
  assert.match(renderPlan({ ...answers, siteName: 'N', languages: ['en'], privateAccess: false }, { ids: ['common'], perStack: { nest: [], react: [] }, added: [] }, { byId: new Map(), byStack: {} }, '/x'), /Mode\s+local trust/);
});

test('local trust --dry-run: accepted without the user module, refused with it', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'cp-'));
  const ok = create(parent, [...COMMON, '--no-private', '--local-trust', '--dry-run']);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /Mode\s+local trust/);
  const libs = makeLibs();
  const bad = create(parent, [...COMMON, '--private', '--multi-user', '--local-trust', '--dry-run'], libs.priv);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /localTrust only applies to applications without the user module/);
  libs.cleanup();
  rmSync(parent, { recursive: true, force: true });
});

test('sqlite --dry-run: anonymous project accepted, a postgres-only private module refused', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'cp-'));
  const ok = create(parent, [...COMMON, '--no-private', '--db', 'sqlite', '--dry-run']);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /Database\s+sqlite \(data\/demo\.db, better-sqlite3 added to back\/package\.local\.json\)/);
  assert.doesNotMatch(ok.stdout, /Redis/);
  const libs = makeLibs();
  const bad = create(parent, [...COMMON, '--private', '--multi-user', '--db', 'sqlite', '--dry-run'], libs.priv);
  assert.equal(bad.status, 2, bad.stdout);
  assert.match(bad.stderr, /module "user" does not support the sqlite database \(it supports: postgres\)/);
  const pg = create(parent, [...COMMON, '--private', '--multi-user', '--db', 'neon', '--dry-run'], libs.priv);
  assert.equal(pg.status, 0, pg.stderr + pg.stdout);
  libs.cleanup();
  assert.deepEqual(readdirSync(parent), [], 'dry-run writes nothing');
  rmSync(parent, { recursive: true, force: true });
});

test('add-module refuses a module that does not support the project database (sqlite), accepts it on Postgres', () => {
  const libs = makeLibs();
  const parent = mkdtempSync(path.join(tmpdir(), 'cp-'));
  let count = 0;
  const project = (engine) => {
    const root = path.join(parent, `${engine}-${count++}`);
    mkdirSync(path.join(root, 'back', '.libs'), { recursive: true });
    symlinkSync(libs.pub, path.join(root, 'back', '.libs', 'vx-public'));
    symlinkSync(libs.priv, path.join(root, 'back', '.libs', 'vx-private'));
    writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({
      projectName: 'demo', contactEmail: 'a@b.co', modules: [], privateAccess: true, database: { engine },
    }));
    writeFileSync(path.join(root, 'shared-modules.json'), JSON.stringify({ nestcommon: ['common', 'database'], reactcommon: ['common'] }));
    return root;
  };
  const sqlite = wizard('add-module.mjs', ['--root', project('sqlite'), '--dry-run', 'user']);
  assert.equal(sqlite.status, 2, sqlite.stdout);
  assert.match(sqlite.stderr, /module "user" does not support the sqlite database/);
  const viaCommerce = wizard('add-module.mjs', ['--root', project('sqlite'), '--dry-run', 'commerce']);
  assert.equal(viaCommerce.status, 2);
  assert.match(viaCommerce.stderr, /module "(user|commerce)" does not support the sqlite database/);
  const okVoice = wizard('add-module.mjs', ['--root', project('sqlite'), '--dry-run', 'voice']);
  assert.equal(okVoice.status, 0, okVoice.stderr);
  const pg = wizard('add-module.mjs', ['--root', project('neon'), '--dry-run', 'user']);
  assert.equal(pg.status, 0, pg.stderr + pg.stdout);
  libs.cleanup();
  rmSync(parent, { recursive: true, force: true });
});
