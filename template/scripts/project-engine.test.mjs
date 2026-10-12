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
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  appendModuleEnv, applyEnvValues, buildConfigEntries, buildEnvFromAnswers, buildSharedModules, dependentsOf,
  filterEnvExample, loadCatalog, patchDefaultConfig, resolveModules, resolveProject, validateAnswers,
  withQuestionDefaults,
} from './lib/project-engine.mjs';
import { addConfigEntries, missingEnvLines } from './add-module.mjs';
import { makeLibs, manifest } from './lib/fixtures.mjs';

const base = { projectName: 'demo', siteName: 'Demo', entityName: 'Acme', contactEmail: 'a@b.co' };

test('closure of requires, per stack, base modules first, cycles tolerated', () => {
  const libs = makeLibs();
  const catalog = loadCatalog({ public: libs.pub, private: libs.priv });
  const r = resolveModules(catalog, ['common', 'database', 'user']);
  assert.deepEqual(r.perStack.nest, ['common', 'database', 'commerce', 'infra', 'user']);
  assert.deepEqual(r.perStack.react, ['common', 'commerce', 'infra', 'user']); // database is nest-only
  assert.deepEqual(r.added, ['commerce', 'infra']);
  assert.deepEqual(resolveModules(catalog, ['nope']).errors, ['unknown module "nope"']);
  assert.deepEqual(dependentsOf(catalog, 'user', r.ids).sort(), ['commerce']);
  libs.cleanup();
});

test('duplicate module in public and private is refused', () => {
  const libs = makeLibs();
  mkdirSync(path.join(libs.priv, 'nest', 'voice'), { recursive: true });
  writeFileSync(path.join(libs.priv, 'nest', 'voice', 'module.json'), JSON.stringify(manifest('voice', { visibility: 'private' })));
  assert.throws(() => loadCatalog({ public: libs.pub, private: libs.priv }), /both vx-public and vx-private/);
  libs.cleanup();
});

test('validation: coherent answers pass, inconsistencies are refused with a message', () => {
  const libs = makeLibs();
  const full = loadCatalog({ public: libs.pub, private: libs.priv });
  const pubOnly = loadCatalog({ public: libs.pub });
  const ok = withQuestionDefaults(full, { ...base, privateAccess: true, multiUser: true });
  assert.deepEqual(validateAnswers(ok, full), []);
  assert.deepEqual(validateAnswers(withQuestionDefaults(pubOnly, { ...base, modules: ['voice'] }), pubOnly), []);
  const errors = (a, c = full) => validateAnswers(a, c).join(' | ');
  assert.match(errors({ ...base, multiUser: true }), /multiUser requires privateAccess/);
  assert.match(errors({ ...base, modules: ['llm'] }), /module "llm" is private \(requested\)/);
  assert.match(errors({ ...base, modules: ['llm'] }), /module "user" is private \(required by another module\)/);
  assert.match(errors({ ...base, privateAccess: true, questions: { commerce: true } }), /needs the "user" module/);
  assert.match(errors({ ...base, privateAccess: true, multiUser: true, questions: { authMethods: ['pigeon'] } }), /authMethods.*values must be among/);
  assert.match(errors({ ...base, questions: { authMethods: ['email'] } }), /does not apply/);
  assert.match(errors({ ...base, modules: ['ghost'] }), /unknown module "ghost"/);
  assert.match(errors({ ...base, projectName: 'Bad Name' }), /kebab-case/);
  assert.match(errors({ ...base, ports: { back: 3000, front: 3000 } }), /must differ/);
  assert.match(errors({ ...base, database: { engine: 'oracle' } }), /database.engine/);
  libs.cleanup();
});

test('question effects: modules, config entries, env, features JSON', () => {
  const libs = makeLibs();
  const catalog = loadCatalog({ public: libs.pub, private: libs.priv });
  const answers = withQuestionDefaults(catalog, {
    ...base, privateAccess: true, multiUser: true, languages: ['en', 'fr'],
    questions: { authMethods: ['wallet', 'social', 'openfort'], authSocials: ['google', 'x'], registration: 'waitlist', multiTenant: true, commerce: true, reownProjectId: 'rp1' },
  });
  assert.deepEqual(validateAnswers(answers, catalog), []);
  const resolved = resolveProject(catalog, answers);
  assert.ok(resolved.perStack.react.includes('waitlist'), 'waitlist added by the registration answer');
  assert.ok(resolved.perStack.nest.includes('tenant'), 'tenant added by multiTenant');
  const entries = Object.fromEntries(buildConfigEntries(catalog, answers, resolved.ids).map((e) => [e.name, e.value]));
  assert.equal(entries.localesLanguages, 'en,fr');
  assert.equal(entries.localeDefault, 'en');
  assert.equal(entries.user_authMethods, '["wallet","social"]'); // openfort filtered out
  assert.equal(entries.user_authEmailEnabled, 'false');
  assert.equal(entries.user_authSocials, '["google","x"]');
  assert.equal(entries.user_registrationMode, 'manual');
  assert.deepEqual(JSON.parse(entries.features), { commerce: { enabled: true } });
  assert.deepEqual(buildEnvFromAnswers(catalog, answers, resolved.ids).front, { VITE_REOWN_PROJECT_ID: 'rp1' });

  const off = withQuestionDefaults(catalog, { ...base, privateAccess: true, multiUser: true });
  const offEntries = Object.fromEntries(buildConfigEntries(catalog, off, resolveProject(catalog, off).ids).map((e) => [e.name, e.value]));
  assert.deepEqual(JSON.parse(offEntries.features), { commerce: { enabled: false } }, 'commerce masked, not removed');
  libs.cleanup();
});

test('anonymous project: no private question, no user in shared-modules.json', () => {
  const libs = makeLibs();
  const catalog = loadCatalog({ public: libs.pub });
  const answers = withQuestionDefaults(catalog, { ...base, modules: ['voice'] });
  assert.deepEqual(answers.questions, {});
  const resolved = resolveProject(catalog, answers);
  assert.deepEqual(buildSharedModules(resolved), { nestcommon: ['common', 'database', 'voice'], reactcommon: ['common', 'voice'] });
  libs.cleanup();
});

test('.env.example blocks: positive, negated, multi-id, unmarked kept, markers removed', () => {
  const text = ['A=1', '# @module user', 'JWT=1', '# @end', '# @module !user', 'ADMIN_TOKEN=', '# @end', '# @module infra,voice', 'METRICS=1', '# @end', 'Z=1'].join('\n');
  assert.equal(filterEnvExample(text, ['common']), 'A=1\nADMIN_TOKEN=\nZ=1');
  assert.equal(filterEnvExample(text, ['common', 'user', 'voice']), 'A=1\nJWT=1\nMETRICS=1\nZ=1');
  assert.throws(() => filterEnvExample('# @module user\nA=1', ['user']), /unterminated/);
  assert.throws(() => filterEnvExample('# @end', ['user']), /without/);
  assert.throws(() => filterEnvExample('# @module a\n# @module b\n# @end', ['a']), /nested/);
});

test('env helpers: manifest variables appended once, values uncomment or append, missing lines detected', () => {
  const libs = makeLibs();
  const catalog = loadCatalog({ public: libs.pub, private: libs.priv });
  const text = appendModuleEnv('# JWT_SECRET=\nA=1\n', catalog, ['common', 'user'], 'nest');
  assert.equal((text.match(/JWT_SECRET/g) ?? []).length, 1, 'already declared (commented) = not repeated');
  const text2 = appendModuleEnv('A=1\n', catalog, ['user'], 'nest');
  assert.match(text2, /# JWT_SECRET=/);
  assert.equal(applyEnvValues('# PORT=1\nB=2\n', { PORT: 9, NEW: 'x' }), 'PORT=9\nB=2\nNEW=x\n');
  assert.deepEqual(missingEnvLines('# A=1\nB=2\n# C=3\n', 'B=9\n'), ['# A=1', '# C=3']);
  libs.cleanup();
});

test('defaultConfig.ts patch (create) and addition (add-module)', () => {
  const src = "export const defaultConfigEntries: DefaultConfigEntry[] = [];\n";
  const patched = patchDefaultConfig(src, [{ name: 'a', value: "it's", description: 'd' }]);
  assert.match(patched, /\{ name: 'a', value: 'it\\'s', description: 'd' \},/);
  assert.throws(() => patchDefaultConfig('export const x = 1;', []), /unexpected content/);
  const more = addConfigEntries(patched, [{ name: 'a', value: 'dup' }, { name: 'b', value: '2' }]);
  assert.deepEqual(more.added.map((e) => e.name), ['b']);
  assert.match(more.source, /name: 'b', value: '2'/);
  assert.equal((more.source.match(/name: 'a'/g) ?? []).length, 1);
});
