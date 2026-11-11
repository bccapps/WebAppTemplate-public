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
import { spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLeaks, parseSince, safeArchiveMembers, scrubForDisplay } from './lib/validation-logs.mjs';
import { checkFilesUnder, loadRegistry, readSchema, validateSchema } from './lib/validation-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'validation-report.mjs');
const TODAY = new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

/** Secret-shaped values built at run time (nothing secret-looking in this file). */
const fakeJwt = () => ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + randomBytes(9).toString('base64url'), randomBytes(24).toString('base64url')].join('.');
const fakeToken = () => `${"tk"}_${randomBytes(30).toString("base64url")}A1`;

const check = (id, extra = {}) => ({
  id, module: 'demo', title: `Title of ${id}`, description: 'The rule.', scenario: 'How it happens.',
  expect: { traces: [id], outcome: 'ok' }, severity: 'medium', since: '2026-11-11', ...extra,
});

function project({ checks, traces = [], appLog = [] }) {
  const root = mkdtempSync(path.join(tmpdir(), 'vreport-'));
  writeFileSync(path.join(root, 'shared-modules.json'), JSON.stringify({ nestcommon: ['demo'], reactcommon: [] }));
  const moduleDir = path.join(root, 'back', '.libs', 'vx-public', 'nest', 'demo', 'validation');
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(path.join(moduleDir, 'checks.json'), JSON.stringify({ checks }));
  const logs = path.join(root, 'back', 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(path.join(logs, `validation-${TODAY}.jsonl`), traces.map((t) => JSON.stringify({ v: 1, ts: now(), app: 'demo', env: 'dev', source: 'back', ...t })).join('\n') + '\n');
  writeFileSync(path.join(logs, `back-${TODAY}.log`), appLog.join('\n') + '\n');
  return root;
}

const report = (root, ...args) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });

const BASE_CHECKS = [
  check('demo.login.otp', { severity: 'critical' }),
  check('demo.settings.saved'),
  check('demo.never.seen', { severity: 'high' }),
  check('demo.export.safe', { severity: 'low', mustNotHappen: ['demo.export.leak:violation'] }),
];

test('statuses, counts, samples and exit 1 on a critical violation', () => {
  const root = project({
    checks: BASE_CHECKS,
    traces: [
      { check: 'demo.login.otp', outcome: 'ok' }, { check: 'demo.login.otp', outcome: 'violation', fields: { reason: 'skipped' } },
      { check: 'demo.settings.saved', outcome: 'ok' }, { check: 'demo.settings.saved', outcome: 'ok', kind: 'summary', suppressed: 5 },
      { check: 'demo.export.leak', outcome: 'violation' }, { check: 'demo.unlisted', outcome: 'info' },
    ],
  });
  const res = report(root, '--json');
  assert.equal(res.status, 1, res.stderr);
  const json = JSON.parse(res.stdout);
  const byId = Object.fromEntries(json.checks.map((c) => [c.id, c]));
  assert.equal(byId['demo.login.otp'].status, 'VIOLATION');
  assert.equal(byId['demo.login.otp'].counts.violation, 1);
  assert.match(byId['demo.login.otp'].samples[0], /"reason":"skipped"/);
  assert.equal(byId['demo.settings.saved'].status, 'OBSERVED_OK');
  assert.equal(byId['demo.settings.saved'].counts.ok, 6);
  assert.equal(byId['demo.never.seen'].status, 'NOT_YET_OBSERVED');
  assert.equal(byId['demo.export.safe'].status, 'VIOLATION');
  assert.deepEqual(json.unknownTraces, [{ check: 'demo.unlisted', count: 1 }]);
  const text = report(root).stdout;
  assert.match(text, /VIOLATION \(2\)\n {2}\[critical\] demo\.login\.otp/);
  assert.match(text, /NOT_YET_OBSERVED \(1\)/);
  rmSync(root, { recursive: true });
});

test('exit 0 when only low checks are violated and nothing leaks; --only and --since filter', () => {
  const root = project({ checks: BASE_CHECKS, traces: [{ check: 'demo.export.leak', outcome: 'violation' }, { check: 'demo.login.otp', outcome: 'ok', ts: '2026-01-01T00:00:00.000Z' }] });
  assert.equal(report(root).status, 0);
  const since = JSON.parse(report(root, '--json', '--since', '1d').stdout);
  assert.equal(since.checks.find((c) => c.id === 'demo.login.otp').status, 'NOT_YET_OBSERVED');
  assert.equal(JSON.parse(report(root, '--json', '--only', 'other').stdout).checks.length, 0);
  rmSync(root, { recursive: true });
});

test('secret leaks: located by file:line, type and fingerprint, the value is never printed', () => {
  const jwt = fakeJwt();
  const token = fakeToken();
  const root = project({
    checks: [check('demo.settings.saved')],
    traces: [{ check: 'demo.settings.saved', outcome: 'ok', fields: { note: `copied ${token}` } }],
    appLog: ['[2026-11-11] boot', `[2026-11-11] auth header Bearer ${jwt}`, '[2026-11-11] mail to jean.dupont@corp.test'],
  });
  const text = report(root);
  assert.equal(text.status, 1);
  assert.match(text.stdout, new RegExp(`jwt {2}sha256:[0-9a-f]{8} len=\\d+ ×1 {2}\\[high\\] {2}back-${TODAY}\\.log:2`));
  assert.match(text.stdout, new RegExp(`prefixed-token {2}sha256:[0-9a-f]{8} len=\\d+ ×1 {2}\\[high\\] {2}validation-${TODAY}\\.jsonl:1`));
  assert.match(text.stdout, /email {2}sha256:[0-9a-f]{8} len=\d+ ×1 {2}\[medium\]/);
  for (const output of [text.stdout, text.stderr, report(root, '--json').stdout]) {
    assert.ok(!output.includes(jwt.slice(-20)) && !output.includes(token.slice(-20)), 'a secret value was printed');
    assert.ok(!output.includes('jean.dupont'), 'an e-mail address was printed');
  }
  rmSync(root, { recursive: true });
});

test('--follow-up prints only what changed since the last run (state in .validation-cache/, git-ignored)', () => {
  const root = project({ checks: BASE_CHECKS, traces: [{ check: 'demo.settings.saved', outcome: 'ok' }] });
  assert.match(report(root, '--follow-up').stdout, /first run/);
  assert.ok(existsSync(path.join(root, '.validation-cache', 'report-state.json')));
  assert.equal(readFileSync(path.join(root, '.validation-cache', '.gitignore'), 'utf8'), '*\n');
  assert.equal(statSync(path.join(root, '.validation-cache', 'report-state.json')).mode & 0o777, 0o600);
  assert.match(report(root, '--follow-up').stdout, /no change/);
  const file = path.join(root, 'back', 'logs', `validation-${TODAY}.jsonl`);
  writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ v: 1, ts: now(), env: 'dev', check: 'demo.never.seen', outcome: 'violation' })}\n`);
  const third = report(root, '--follow-up');
  assert.match(third.stdout, /demo\.never\.seen: NOT_YET_OBSERVED → VIOLATION/);
  assert.doesNotMatch(third.stdout, /demo\.settings\.saved/);
  assert.match(third.stdout, /still open: 1 violation/);
  assert.equal(third.status, 1);
  rmSync(root, { recursive: true });
});

test('--logs accepts a tar archive (only validation members are extracted) and --env filters', () => {
  const root = project({ checks: [check('demo.settings.saved')], traces: [{ check: 'demo.settings.saved', outcome: 'ok', env: 'preprod' }] });
  const archive = path.join(root, 'logs.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', path.join(root, 'back'), 'logs']);
  const json = JSON.parse(report(root, '--json', '--logs', archive, '--env', 'preprod').stdout);
  assert.equal(json.checks[0].status, 'OBSERVED_OK');
  assert.equal(json.stats.files, 1);
  assert.equal(JSON.parse(report(root, '--json', '--logs', archive, '--env', 'dev').stdout).checks[0].status, 'NOT_YET_OBSERVED');
  const listing = ['logs/validation-2026-11-11.jsonl', '/etc/validation-2026-11-11.jsonl', '../validation-2026-11-11.jsonl', '--to-command=sh/validation-2026-11-11.jsonl',
    'logs/*/validation-2026-11-11.jsonl', 'logs/back-2026-11-11.log', 'logs/._validation-2026-11-11.jsonl'].join('\n');
  assert.deepEqual(safeArchiveMembers(listing), ['logs/validation-2026-11-11.jsonl']);
  rmSync(root, { recursive: true });
});

test('--check-registry: valid → 0; schema, module and duplicate errors → 2', () => {
  const ok = project({ checks: [check('demo.a'), check('demo.b', { sources: ['front'], preLogin: true })] });
  assert.equal(report(ok, '--check-registry').status, 0);
  const bad = project({ checks: [check('demo.a'), check('demo.a'), check('demo.c', { module: 'other' }), check('demo.d', { severity: 'urgent' }), check('demo.e', { preLogin: true })] });
  const res = report(bad, '--check-registry');
  assert.equal(res.status, 2);
  assert.match(res.stdout, /must be one of critical, high, medium, low/);
  const registry = loadRegistry([{ module: 'demo', origin: 'test', file: path.join(ok, 'back/.libs/vx-public/nest/demo/validation/checks.json') }]);
  assert.equal(registry.errors.length, 0);
  writeFileSync(path.join(bad, 'back/.libs/vx-public/nest/demo/validation/checks.json'), JSON.stringify({ checks: [check('demo.a'), check('demo.a'), check('demo.c', { module: 'other' }), check('demo.e', { preLogin: true })] }));
  const out = report(bad, '--check-registry').stdout;
  assert.match(out, /id already declared/);
  assert.match(out, /"module" is "other"/);
  assert.match(out, /"preLogin" needs "front"/);
  for (const dir of [ok, bad]) rmSync(dir, { recursive: true });
});

test('usage errors exit 2', () => {
  assert.equal(report(tmpdir(), '--env', 'prod').status, 2);
  assert.equal(report(tmpdir(), '--since', 'yesterday').status, 2);
  assert.equal(report(tmpdir(), '--bogus').status, 2);
});

test('detectors: the analyzer flags what the back sanitizer removes, scrubbed samples hide values', () => {
  const token = fakeToken();
  assert.deepEqual(findLeaks(`x ${token} y`, true).map((l) => l.type), ['prefixed-token', 'base64-blob']);
  assert.equal(findLeaks('"password":"[redacted:12]","token":"sha256:0a1b2c3d;len=40","to":"j***@example.fr"', true).length, 0);
  assert.equal(findLeaks(`password=${randomBytes(6).toString('hex')}`, false)[0].type, 'credential-assignment');
  assert.equal(findLeaks('a'.repeat(64).replace(/a/g, 'f'), false)[0].severity, 'low');
  assert.ok(!scrubForDisplay(`id ${token}`).includes(token.slice(3, 20)));
  assert.equal(parseSince('2d', Date.parse('2026-11-11T00:00:00Z')), Date.parse('2026-11-09T00:00:00Z'));
  assert.equal(parseSince('soon'), null);
});

test('every checks.json of this repository follows the schema (CI gate of vx-public)', () => {
  const repo = path.resolve(HERE, '..', '..');
  const entries = ['nest', 'react'].flatMap((stack) => checkFilesUnder(path.join(repo, stack), stack));
  const { errors } = loadRegistry(entries);
  assert.deepEqual(errors, []);
  const schema = readSchema();
  assert.deepEqual(validateSchema({ checks: [] }, schema), []);
  assert.ok(validateSchema({ checks: [{ id: 'X' }] }, schema).length > 0);
  assert.ok(readdirSync(repo).includes('nest'));
});
