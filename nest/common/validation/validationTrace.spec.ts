/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { leaksSecret, secretFixtures } from './secretFixtures.testkit';
import { TraceFileSink } from './traceFileSink';
import { configureValidationTrace, flushValidationTrace, isValidationTraceEnabled, isValidationTraceEnabledFor, recordValidationTrace, vtrace } from './validationTrace';

const DEV = { APP_ENV: 'dev', VALIDATION_TRACE: 'on', PROJECT_NAME: 'demo' };
let roots: string;

/** A module folder declaring the traces used below, with their fields. */
beforeAll(() => {
  roots = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrace-checks-'));
  fs.mkdirSync(path.join(roots, 'demo', 'validation'), { recursive: true });
  const check = (id: string, extra: object) => ({ id, module: 'demo', expect: { traces: [id], outcome: 'ok' }, ...extra });
  fs.writeFileSync(path.join(roots, 'demo', 'validation', 'checks.json'), JSON.stringify({ checks: [
    check('user.login.otp-required', { fields: { method: ['email', 'sms'], attempts: 'number' } }),
    check('market.quote.stale', { fields: { i: 'number' } }),
    check('a.b', { fields: '*', fieldsJustification: 'internal counters only, no user data' }),
    check('a.c', { fields: '*', fieldsJustification: 'internal counters only, no user data' }),
    check('demo.front', { sources: ['front'], fields: { step: 'string' } }),
  ] }));
});
afterAll(() => fs.rmSync(roots, { recursive: true, force: true }));

function memory() {
  const lines: { line: string; cls?: string }[] = [];
  return {
    lines,
    sink: { write: (line: string, cls?: string) => (lines.push({ line, cls }), true) },
    parsed: () => lines.map((l) => JSON.parse(l.line)),
  };
}

afterEach(() => configureValidationTrace({ env: {} }));

describe('isValidationTraceEnabledFor (fail-closed switch)', () => {
  it.each([
    [{}, false], [{ APP_ENV: 'prod' }, false], [{ APP_ENV: 'production' }, false], [{ APP_ENV: 'desktop' }, false], [{ APP_ENV: 'staging' }, false],
    [{ APP_ENV: 'dev' }, true], [{ APP_ENV: ' DEV ' }, true], [{ APP_ENV: 'dev', VALIDATION_TRACE: 'off' }, false], [{ APP_ENV: 'dev', VALIDATION_TRACE: 'yes' }, false],
    [{ APP_ENV: 'preprod' }, false], [{ APP_ENV: 'preprod', VALIDATION_TRACE: 'on' }, true], [{ APP_ENV: ' Preprod ', VALIDATION_TRACE: ' ON ' }, true],
    [{ APP_ENV: 'dev', NODE_ENV: 'test' }, false], [{ APP_ENV: 'dev', NODE_ENV: 'test', VALIDATION_TRACE: 'on' }, true], [{ APP_ENV: 'prod', VALIDATION_TRACE: 'on' }, false],
  ])('%j → %s', (env, expected) => expect(isValidationTraceEnabledFor(env)).toBe(expected));
});

describe('vtrace when inactive (production, no APP_ENV, preprod without opt-in)', () => {
  it.each([{ APP_ENV: 'prod', VALIDATION_TRACE: 'on' }, {}, { APP_ENV: 'preprod' }])('evaluates nothing, writes nothing (%j)', (env) => {
    const out = memory();
    const log = jest.fn();
    const lazy = jest.fn(() => ({ a: 1 }));
    configureValidationTrace({ env, sink: out.sink, log, checkRoots: [roots] });
    vtrace('user.login.otp-required', 'violation', lazy);
    flushValidationTrace();
    expect(isValidationTraceEnabled()).toBe(false);
    expect(lazy).not.toHaveBeenCalled();
    expect(out.lines).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('vtrace when active', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrace-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('appends valid JSON lines (declared fields only) to logs/validation-<day>.jsonl (0600, dir .gitignore) and to the Nest logger', () => {
    const log = jest.fn();
    const now = Date.parse('2026-11-11T10:00:00Z');
    configureValidationTrace({ env: { ...DEV, LOG_DIR: dir }, log, now: () => now, checkRoots: [roots] });
    vtrace('user.login.otp-required', 'ok', { method: 'email', requestId: 'req-1', extra: 'dropped' });
    vtrace('user.login.otp-required', 'violation', () => ({ attempts: 3 }));
    vtrace('undeclared.trace', 'info', { anything: 'x' });
    const file = path.join(dir, 'validation-2026-11-11.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n');
    expect(lines[0]).toEqual({
      v: 1, ts: '2026-11-11T10:00:00.000Z', app: 'demo', env: 'dev', check: 'user.login.otp-required', outcome: 'ok', source: 'back',
      requestId: expect.stringMatching(/^hmac:[0-9a-f]{16}$/), fields: { method: 'email', _droppedFields: 1 },
    });
    expect(lines[1]).toMatchObject({ outcome: 'violation', fields: { attempts: 3 } });
    expect(lines[2]).toMatchObject({ check: 'undeclared.trace', fields: { _droppedFields: 1 } });
    expect(log).toHaveBeenCalledTimes(3);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(lines[0]);
  });

  it('refuses to write through a symbolic link planted at the day file (O_NOFOLLOW)', () => {
    const target = path.join(dir, 'elsewhere.txt');
    fs.writeFileSync(target, 'ORIGINAL');
    fs.symlinkSync(target, path.join(dir, 'validation-2026-11-11.jsonl'));
    configureValidationTrace({ env: { ...DEV, LOG_DIR: dir }, log: () => undefined, now: () => Date.parse('2026-11-11T10:00:00Z'), checkRoots: [roots] });
    expect(() => vtrace('a.b', 'ok', { n: 1 })).not.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL');
  });

  it('writes no fixture secret, neither in the file nor in the logger ("*" rules)', () => {
    const log = jest.fn();
    configureValidationTrace({ env: { ...DEV, LOG_DIR: dir }, log, checkRoots: [roots] });
    const fixtures = secretFixtures();
    vtrace('a.b', 'info', { ...fixtures, token: fixtures.jwt, note: `bad ${fixtures.appToken}`, requestId: fixtures.appToken });
    const written = fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n') + JSON.stringify(log.mock.calls);
    for (const secret of Object.values(fixtures)) expect(leaksSecret(written, secret)).toBe(false);
  });

  it('samples per source, check and outcome: N detailed lines per minute, then one summary line', () => {
    let now = Date.parse('2026-11-11T10:00:00Z');
    const out = memory();
    const lazy = jest.fn(() => ({ i: 1 }));
    configureValidationTrace({ env: { ...DEV, VALIDATION_TRACE_PER_MINUTE: '3' }, sink: out.sink, log: () => undefined, now: () => now, checkRoots: [roots] });
    for (let i = 0; i < 10; i += 1) vtrace('market.quote.stale', 'violation', lazy);
    vtrace('market.quote.stale', 'ok');
    expect(lazy).toHaveBeenCalledTimes(3);
    now += 61_000;
    vtrace('market.quote.stale', 'violation', { i: 2 });
    const lines = out.parsed();
    expect(lines.filter((l) => !l.kind)).toHaveLength(5);
    expect(lines.find((l) => l.kind === 'summary')).toMatchObject({ check: 'market.quote.stale', outcome: 'violation', source: 'back', suppressed: 7 });
    expect(out.lines.find((l) => JSON.parse(l.line).outcome === 'violation')?.cls).toBe('violation');
  });

  it('gives the front its own sampling per client: one client cannot use up the budget of the others', () => {
    const out = memory();
    configureValidationTrace({ env: { ...DEV, VALIDATION_TRACE_PER_MINUTE: '20' }, sink: out.sink, log: () => undefined, checkRoots: [roots] });
    for (let i = 0; i < 12; i += 1) recordValidationTrace('demo.front', 'ok', { step: 'a' }, { source: 'front', client: 'ip:203.0.113.9' });
    recordValidationTrace('demo.front', 'ok', { step: 'b' }, { source: 'front', client: 'ip:198.51.100.7' });
    recordValidationTrace('demo.front', 'ok', { requestId: 'forged' }, { source: 'front', client: 'ip:198.51.100.8' });
    flushValidationTrace();
    const details = out.parsed().filter((l) => !l.kind);
    expect(details).toHaveLength(7);
    expect(details.every((l) => l.source === 'front' && l.requestId === undefined)).toBe(true);
    expect(out.parsed().find((l) => l.kind === 'summary')).toMatchObject({ source: 'front', suppressed: 7 });
    expect(out.lines.every((l) => JSON.parse(l.line).kind === 'summary' || l.cls === 'front')).toBe(true);
    expect(JSON.stringify(out.lines)).not.toContain('203.0.113.9');
  });

  it('never throws: failing sink, failing lazy fields, bad names, oversized line', () => {
    configureValidationTrace({ env: DEV, sink: { write: () => { throw new Error('disk'); } }, log: () => undefined, checkRoots: [roots] });
    expect(() => vtrace('a.b', 'ok')).not.toThrow();
    const out = memory();
    configureValidationTrace({ env: DEV, sink: out.sink, log: () => undefined, checkRoots: [roots] });
    expect(() => vtrace('a.b', 'ok', () => { throw new Error('boom'); })).not.toThrow();
    expect(() => vtrace('Bad Name!', 'ok')).not.toThrow();
    expect(() => vtrace('a.b', 'maybe' as 'ok')).not.toThrow();
    vtrace('a.c', 'info', Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i}`, 'ok: 1, '.repeat(28)])));
    expect(out.parsed().map((l) => [l.check, l.fields])).toEqual([['a.b', { fieldsError: true }], ['a.c', { _truncated: true }]]);
  });
});

describe('TraceFileSink', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsink-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const capped = (cls: string, maxBytes: number) => JSON.stringify({ v: 1, env: 'dev', check: 'validation.trace.capped', outcome: 'info', fields: { traceClass: cls, maxBytes } });
  const sink = (overrides: Partial<ConstructorParameters<typeof TraceFileSink>[0]> = {}) =>
    new TraceFileSink({ dir, maxBytes: 1024 * 1024, retentionDays: 7, now: () => Date.parse('2026-11-11T10:00:00Z'), onFailure: () => undefined, cappedLine: capped, ...overrides });
  const read = () => fs.readFileSync(path.join(dir, 'validation-2026-11-11.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('keeps budgets per class: front ≤ 25 %, ordinary back ≤ 85 %, the rest reserved to back violations', () => {
    const s = sink({ maxBytes: 2000 });
    const line = JSON.stringify({ pad: 'x'.repeat(90) }); // 101 bytes with its newline
    const front = Array.from({ length: 10 }, () => s.write(line, 'front')).filter(Boolean).length;
    const back = Array.from({ length: 30 }, () => s.write(line, 'back')).filter(Boolean).length;
    const violations = Array.from({ length: 5 }, () => s.write(line, 'violation')).filter(Boolean).length;
    expect([front, violations]).toEqual([4, 2]);
    expect(back).toBe(11);
    const markers = read().filter((l) => l.check === 'validation.trace.capped');
    expect(markers.map((m) => m.fields.traceClass)).toEqual(['front', 'back', 'violation']);
    expect(markers.every((m) => m.env === 'dev')).toBe(true);
  });

  it('deletes only validation files older than the retention', () => {
    for (const name of ['validation-2026-01-01.jsonl', 'validation-2026-11-01.jsonl', 'validation-2026-11-05.jsonl', 'back-2026-01-01.log', 'validation-notes.txt']) {
      fs.writeFileSync(path.join(dir, name), '{}\n');
    }
    sink().write('{}');
    expect(fs.readdirSync(dir).sort()).toEqual(['.gitignore', 'back-2026-01-01.log', 'validation-2026-11-05.jsonl', 'validation-2026-11-11.jsonl', 'validation-notes.txt']);
  });

  it('gives up once, without throwing, when the directory is unusable', () => {
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    const onFailure = jest.fn();
    const s = sink({ dir: blocker, onFailure });
    expect(s.write('{}')).toBe(false);
    expect(s.write('{}')).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
