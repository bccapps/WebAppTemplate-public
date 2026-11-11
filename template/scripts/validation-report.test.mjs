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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { regularMembers } from './lib/validation-archive.mjs';
import { findLeaks, openLogSource, parseSince, scrubForDisplay } from './lib/validation-logs.mjs';
import { checkFilesUnder, loadRegistry, readSchema, validateSchema } from './lib/validation-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'validation-report.mjs');
const TODAY = new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

/** Secret-shaped values built at run time (nothing secret-looking in this file). */
const fakeJwt = () => ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + randomBytes(9).toString('base64url'), randomBytes(24).toString('base64url')].join('.');
const fakeToken = () => `${'tk'}_${randomBytes(30).toString('base64url')}A1`;

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
const json = (root, ...args) => JSON.parse(report(root, '--json', ...args).stdout);
const byId = (out) => Object.fromEntries(out.checks.map((c) => [c.id, c]));

const BASE_CHECKS = [
  check('demo.login.otp', { severity: 'critical' }),
  check('demo.settings.saved'),
  check('demo.never.seen', { severity: 'high' }),
  check('demo.export.safe', { severity: 'low', mustNotHappen: ['demo.export.leak:violation'] }),
];

test('statuses, counts per source, field names only in samples, exit 1 on a critical violation', () => {
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
  const checks = byId(JSON.parse(res.stdout));
  assert.equal(checks['demo.login.otp'].status, 'VIOLATION');
  assert.deepEqual(checks['demo.login.otp'].counts.violation, { back: 1, front: 0 });
  assert.match(checks['demo.login.otp'].samples[0], /demo\.login\.otp violation \(back\) fields: reason$/);
  assert.doesNotMatch(JSON.stringify(checks), /skipped/);
  assert.equal(checks['demo.settings.saved'].status, 'OBSERVED_OK');
  assert.deepEqual(checks['demo.settings.saved'].counts.ok, { back: 6, front: 0 });
  assert.equal(checks['demo.never.seen'].status, 'NOT_YET_OBSERVED');
  assert.equal(checks['demo.export.safe'].status, 'VIOLATION');
  const text = report(root).stdout;
  assert.match(text, /VIOLATION \(2\)\n {2}\[critical\] demo\.login\.otp .* ok\(back\) 1 · ok\(front\) 0/);
  assert.match(text, /BLOCKING: VIOLATION of critical check demo\.login\.otp/);
  assert.match(report(root, '--show-values').stdout, /"reason":"skipped"/);
  rmSync(root, { recursive: true });
});

test('front traces never prove nor break a back check; a critical check needs back evidence', () => {
  const root = project({
    checks: [check('demo.back.only', { severity: 'critical' }), check('demo.front.crit', { severity: 'high', sources: ['back', 'front'] }), check('demo.front.low', { sources: ['front'] })],
    traces: [
      { check: 'demo.back.only', outcome: 'ok', source: 'front' }, { check: 'demo.back.only', outcome: 'violation', source: 'front' },
      { check: 'demo.front.crit', outcome: 'ok', source: 'front' }, { check: 'demo.front.low', outcome: 'ok', source: 'front' },
    ],
  });
  const res = report(root, '--json');
  assert.equal(res.status, 0, res.stdout);
  const checks = byId(JSON.parse(res.stdout));
  assert.equal(checks['demo.back.only'].status, 'NOT_YET_OBSERVED');
  assert.equal(checks['demo.back.only'].ignoredFront, 2);
  assert.equal(checks['demo.front.crit'].status, 'NOT_YET_OBSERVED');
  assert.match(checks['demo.front.crit'].note, /proven by back traces/);
  assert.equal(checks['demo.front.low'].status, 'OBSERVED_OK');
  rmSync(root, { recursive: true });
});

test('exit 0 when only low checks are violated and nothing leaks; --only and --since filter', () => {
  const root = project({ checks: BASE_CHECKS, traces: [{ check: 'demo.export.leak', outcome: 'violation' }, { check: 'demo.login.otp', outcome: 'ok', ts: '2026-01-01T00:00:00.000Z' }] });
  assert.equal(report(root).status, 0);
  assert.equal(byId(json(root, '--since', '1d'))['demo.login.otp'].status, 'NOT_YET_OBSERVED');
  assert.equal(json(root, '--only', 'other').checks.length, 0);
  rmSync(root, { recursive: true });
});

test('a daily cap reached in the period is counted before the env filter and blocks', () => {
  const capped = { check: 'validation.trace.capped', outcome: 'info', env: 'dev', fields: { traceClass: 'front', maxBytes: 20 } };
  const root = project({ checks: [check('demo.settings.saved')], traces: [{ check: 'demo.settings.saved', outcome: 'ok', env: 'preprod' }, capped] });
  const res = report(root, '--env', 'preprod');
  assert.equal(res.status, 1);
  assert.match(res.stdout, /BLOCKING: daily cap reached \(front\) in validation-/);
  assert.equal(report(root, '--since', '2099-01-01').status, 0);
  rmSync(root, { recursive: true });
});

test('secret leaks: file:line, type, keyed fingerprint (long values only), the value is never printed', () => {
  const jwt = fakeJwt();
  const token = fakeToken();
  const root = project({
    checks: [check('demo.settings.saved')],
    traces: [{ check: 'demo.settings.saved', outcome: 'ok', fields: { note: `copied ${token}` } }],
    appLog: ['[2026-11-11] boot', `[2026-11-11] auth header Bearer ${jwt}`, '[2026-11-11] mail to jean.dupont@corp.test', '[2026-11-11] password=abc12'],
  });
  const text = report(root);
  assert.equal(text.status, 1);
  assert.match(text.stdout, new RegExp(`jwt {2}hmac:[0-9a-f]{16} len=\\d+ ×1 {2}\\[high\\] {2}back-${TODAY}\\.log:2`));
  assert.match(text.stdout, new RegExp(`prefixed-token {2}hmac:[0-9a-f]{16} len=\\d+ ×1 {2}\\[high\\] {2}validation-${TODAY}\\.jsonl:1`));
  assert.match(text.stdout, /email {2}hmac:[0-9a-f]{16} len=\d+ ×1 {2}\[medium\]/);
  assert.match(text.stdout, new RegExp(`credential-assignment {2}len=5 ×1 {2}\\[high\\] {2}back-${TODAY}\\.log:4`));
  for (const output of [text.stdout, text.stderr, report(root, '--json').stdout, report(root, '--show-values').stdout]) {
    assert.ok(!output.includes(jwt.slice(-20)) && !output.includes(token.slice(-20)), 'a secret value was printed');
    assert.ok(!output.includes('jean.dupont') && !output.includes('abc12'), 'a value was printed');
  }
  assert.equal(statSync(path.join(root, '.validation-cache', 'fingerprint.key')).mode & 0o777, 0o600);
  rmSync(root, { recursive: true });
});

test('--follow-up prints only what changed since the last run (state in .validation-cache/, git-ignored)', () => {
  const root = project({ checks: BASE_CHECKS, traces: [{ check: 'demo.settings.saved', outcome: 'ok' }] });
  assert.match(report(root, '--follow-up').stdout, /first run/);
  assert.equal(readFileSync(path.join(root, '.validation-cache', '.gitignore'), 'utf8'), '*\n');
  assert.equal(statSync(path.join(root, '.validation-cache', 'report-state.json')).mode & 0o777, 0o600);
  assert.match(report(root, '--follow-up').stdout, /no change/);
  const file = path.join(root, 'back', 'logs', `validation-${TODAY}.jsonl`);
  writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ v: 1, ts: now(), env: 'dev', source: 'back', check: 'demo.never.seen', outcome: 'violation' })}\n`);
  const third = report(root, '--follow-up');
  assert.match(third.stdout, /demo\.never\.seen: NOT_YET_OBSERVED → VIOLATION/);
  assert.doesNotMatch(third.stdout, /demo\.settings\.saved/);
  assert.match(third.stdout, /still open: 1 violation/);
  assert.equal(third.status, 1);
  rmSync(root, { recursive: true });
});

test('a symbolic link at .validation-cache is refused (exit 2); --show-values is refused for preprod', () => {
  const root = project({ checks: [check('demo.settings.saved')] });
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'vreport-target-'));
  symlinkSync(elsewhere, path.join(root, '.validation-cache'));
  assert.equal(report(root).status, 2);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(report(root, '--preprod', '--no-fetch', '--show-values').status, 2);
  for (const dir of [root, elsewhere]) rmSync(dir, { recursive: true });
});

test('--logs reads a tar archive without tar: regular validation members only, links and odd names ignored', () => {
  const root = project({ checks: [check('demo.settings.saved')], traces: [{ check: 'demo.settings.saved', outcome: 'ok', env: 'preprod' }] });
  const archive = path.join(root, 'logs.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', path.join(root, 'back'), 'logs']);
  const out = json(root, '--logs', archive, '--env', 'preprod');
  assert.equal(out.checks[0].status, 'OBSERVED_OK');
  assert.equal(out.stats.files, 1);
  assert.equal(json(root, '--logs', archive, '--env', 'dev').checks[0].status, 'NOT_YET_OBSERVED');
  rmSync(root, { recursive: true });
});

/** Minimal tar writer for hostile members (links with absolute targets, then a regular file of the same name...). */
function tarEntry(name, { type = '0', data = Buffer.alloc(0), link = '' } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write(link, 157, 100);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

test('hostile archives never write nor read outside the private copy (canary intact)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vreport-tar-'));
  const canary = path.join(dir, 'canary.txt');
  writeFileSync(canary, 'CANARY');
  const line = Buffer.from('{"v":1,"ts":"2026-11-11T00:00:00.000Z","env":"dev","check":"demo.x","outcome":"ok"}\n');
  const archives = {
    'hardlink-then-file.tar': [tarEntry('validation-2026-11-11.jsonl', { type: '1', link: canary }), tarEntry('validation-2026-11-11.jsonl', { data: Buffer.from('OVERWRITTEN\n') })],
    'symlink-then-file.tar': [tarEntry('validation-2026-11-11.jsonl', { type: '2', link: canary }), tarEntry('validation-2026-11-11.jsonl', { data: Buffer.from('OVERWRITTEN\n') })],
    'dir-symlink.tar': [tarEntry('logs', { type: '2', link: dir }), tarEntry('logs/validation-2026-11-11.jsonl', { data: Buffer.from('THROUGH-LINK\n') })],
    'names.tar': [tarEntry('../validation-2026-11-15.jsonl', { data: line }), tarEntry('/tmp/validation-2026-11-15.jsonl', { data: line }), tarEntry('-x/validation-2026-11-15.jsonl', { data: line })],
  };
  for (const [name, entries] of Object.entries(archives)) {
    const file = path.join(dir, name);
    writeFileSync(file, Buffer.concat([...entries, Buffer.alloc(1024)]));
    const { dir: copy, cleanup } = openLogSource(file);
    for (const sub of readdirSync(copy)) for (const f of readdirSync(path.join(copy, sub))) assert.ok(statSync(path.join(copy, sub, f)).isFile());
    cleanup();
    assert.equal(readFileSync(canary, 'utf8'), 'CANARY', name);
    assert.ok(!existsSync(copy));
  }
  assert.deepEqual(readdirSync(dir).sort(), ['canary.txt', ...Object.keys(archives)].sort());
  assert.equal(regularMembers(Buffer.concat([...archives['names.tar'], Buffer.alloc(1024)])).length, 3);
  const broken = path.join(dir, 'broken.tar');
  writeFileSync(broken, Buffer.alloc(600, 'z'));
  assert.throws(() => openLogSource(broken), /corrupt tar header/);
  rmSync(dir, { recursive: true });
});

test('--check-registry: valid → 0; schema, module, duplicate, "*" and shared-name errors → 2', () => {
  const ok = project({ checks: [check('demo.a', { fields: { step: ['a', 'b'], n: 'number' } }), check('demo.b', { sources: ['front'], preLogin: true }),
    check('demo.c', { fields: '*', fieldsJustification: 'internal counters, no user data' })] });
  assert.equal(report(ok, '--check-registry').status, 0);
  const bad = project({ checks: [check('demo.a'), check('demo.a'), check('demo.c', { module: 'other' }), check('demo.d', { severity: 'urgent' }), check('demo.e', { preLogin: true })] });
  const res = report(bad, '--check-registry');
  assert.equal(res.status, 2);
  assert.match(res.stdout, /must be one of critical, high, medium, low/);
  const file = path.join(bad, 'back/.libs/vx-public/nest/demo/validation/checks.json');
  writeFileSync(file, JSON.stringify({ checks: [
    check('demo.a'), check('demo.a'), check('demo.c', { module: 'other' }), check('demo.e', { preLogin: true }),
    check('demo.f', { sources: ['front'], fields: '*', fieldsJustification: 'not allowed for the front' }), check('demo.g', { fields: '*' }),
    check('demo.h', { sources: ['front'] }), check('demo.i', { expect: { traces: ['demo.h'], outcome: 'ok' } }),
    check('demo.j', { fields: { n: 'number' } }), check('demo.k', { expect: { traces: ['demo.j'], outcome: 'ok' }, fields: { n: 'string' } }),
  ] }));
  const out = report(bad, '--check-registry').stdout;
  for (const message of [/id already declared/, /"module" is "other"/, /"preLogin" needs "front"/, /"\*" is refused for a check with a front source/,
    /"\*" needs a "fieldsJustification"/, /trace "demo\.h": sent by the front .* used by back-only demo\.i/, /field "n" typed differently/]) assert.match(out, message);
  for (const dir of [ok, bad]) rmSync(dir, { recursive: true });
});

test('usage errors exit 2', () => {
  assert.equal(report(tmpdir(), '--env', 'prod').status, 2);
  assert.equal(report(tmpdir(), '--since', 'yesterday').status, 2);
  assert.equal(report(tmpdir(), '--bogus').status, 2);
});

test('detectors: aligned with the back sanitizer, short values not fingerprinted, scrubbed samples hide values', () => {
  const token = fakeToken();
  assert.deepEqual(findLeaks(`x ${token} y`, true).map((l) => l.type), ['prefixed-token', 'base64-blob']);
  assert.equal(findLeaks('"password":"[redacted:12]","token":"hmac:0a1b2c3d4e5f6a7b;len=40","to":"j***@example.fr"', true).length, 0);
  const short = findLeaks(`password=${randomBytes(3).toString('hex')}`, false)[0];
  assert.deepEqual([short.type, short.fingerprint, short.length], ['credential-assignment', null, 6]);
  assert.equal(findLeaks('f'.repeat(64), false)[0].severity, 'low');
  assert.ok(!scrubForDisplay(`id ${token}`).includes(token.slice(3, 20)));
  assert.equal(parseSince('2d', Date.parse('2026-11-11T00:00:00Z')), Date.parse('2026-11-09T00:00:00Z'));
  assert.equal(parseSince('soon'), null);
});

test('no ReDoS: hostile 100 KB lines are scanned and scrubbed in under 100 ms', () => {
  const N = 100_000;
  for (const unit of ['a', 'a@', 'a.', 'eyJ', 'password=', 'x://a:', 'bearer ', 'f', 'tk_', 'Ab1+', '!']) {
    const text = unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
    const t0 = performance.now();
    findLeaks(text, true);
    scrubForDisplay(text);
    assert.ok(performance.now() - t0 < 100, `${unit}: ${(performance.now() - t0).toFixed(0)} ms`);
  }
});

test('every checks.json of this repository follows the schema (CI gate of vx-public)', () => {
  const repo = path.resolve(HERE, '..', '..');
  const entries = ['nest', 'react'].flatMap((stack) => checkFilesUnder(path.join(repo, stack), stack));
  const { errors } = loadRegistry(entries);
  assert.deepEqual(errors, []);
  const schema = readSchema();
  assert.deepEqual(validateSchema({ checks: [] }, schema), []);
  assert.ok(validateSchema({ checks: [{ id: 'X' }] }, schema).length > 0);
});
