/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { leaksSecret, secretFixtures } from './secretFixtures.testkit';
import { TraceFileSink } from './traceFileSink';
import { configureValidationTrace, flushValidationTrace, isValidationTraceEnabled, isValidationTraceEnabledFor, vtrace } from './validationTrace';

const DEV = { APP_ENV: 'dev', VALIDATION_TRACE: 'on', PROJECT_NAME: 'demo' };

function memory() {
  const lines: string[] = [];
  return { lines, sink: { write: (line: string) => (lines.push(line), true) }, parsed: () => lines.map((l) => JSON.parse(l)) };
}

afterEach(() => configureValidationTrace({ env: {} }));

describe('isValidationTraceEnabledFor (fail-closed switch)', () => {
  it.each([
    [{}, false], [{ APP_ENV: 'prod' }, false], [{ APP_ENV: 'production' }, false], [{ APP_ENV: 'desktop' }, false], [{ APP_ENV: 'staging' }, false],
    [{ APP_ENV: '' }, false], [{ APP_ENV: 'dev' }, true], [{ APP_ENV: ' Preprod ' }, true], [{ APP_ENV: 'dev', VALIDATION_TRACE: 'off' }, false],
    [{ APP_ENV: 'dev', VALIDATION_TRACE: 'yes' }, false], [{ APP_ENV: 'dev', NODE_ENV: 'test' }, false], [{ APP_ENV: 'dev', NODE_ENV: 'test', VALIDATION_TRACE: 'on' }, true],
    [{ APP_ENV: 'prod', VALIDATION_TRACE: 'on' }, false],
  ])('%j → %s', (env, expected) => expect(isValidationTraceEnabledFor(env)).toBe(expected));
});

describe('vtrace when inactive (production, no APP_ENV)', () => {
  it.each([{ APP_ENV: 'prod', VALIDATION_TRACE: 'on' }, {}])('evaluates nothing, writes nothing (%j)', (env) => {
    const out = memory();
    const log = jest.fn();
    const lazy = jest.fn(() => ({ a: 1 }));
    configureValidationTrace({ env, sink: out.sink, log });
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

  it('appends valid JSON lines to logs/validation-<day>.jsonl (0600) and to the Nest logger', () => {
    const log = jest.fn();
    const now = Date.parse('2026-11-11T10:00:00Z');
    configureValidationTrace({ env: { ...DEV, LOG_DIR: dir }, log, now: () => now });
    vtrace('user.login.otp-required', 'ok', { method: 'email', requestId: 'req-1' });
    vtrace('user.login.otp-required', 'violation', () => ({ attempts: 3 }));
    const file = path.join(dir, 'validation-2026-11-11.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(lines).toEqual([
      { v: 1, ts: '2026-11-11T10:00:00.000Z', app: 'demo', env: 'dev', check: 'user.login.otp-required', outcome: 'ok', source: 'back', requestId: 'req-1', fields: { method: 'email' } },
      { v: 1, ts: '2026-11-11T10:00:00.000Z', app: 'demo', env: 'dev', check: 'user.login.otp-required', outcome: 'violation', source: 'back', fields: { attempts: 3 } },
    ]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(lines[0]);
  });

  it('writes no fixture secret, neither in the file nor in the logger', () => {
    const log = jest.fn();
    configureValidationTrace({ env: { ...DEV, LOG_DIR: dir }, log });
    const fixtures = secretFixtures();
    vtrace('auth.check', 'info', { ...fixtures, token: fixtures.jwt, note: `bad ${fixtures.appToken}`, requestId: fixtures.appToken });
    const written = fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n') + JSON.stringify(log.mock.calls);
    for (const secret of Object.values(fixtures)) expect(leaksSecret(written, secret)).toBe(false);
  });

  it('samples: N detailed lines per (check, outcome) and minute, then one summary line with the count', () => {
    let now = Date.parse('2026-11-11T10:00:00Z');
    const out = memory();
    const lazy = jest.fn(() => ({ i: 1 }));
    configureValidationTrace({ env: { ...DEV, VALIDATION_TRACE_PER_MINUTE: '3' }, sink: out.sink, log: () => undefined, now: () => now });
    for (let i = 0; i < 10; i += 1) vtrace('market.quote.stale', 'violation', lazy);
    vtrace('market.quote.stale', 'ok');
    expect(lazy).toHaveBeenCalledTimes(3);
    now += 61_000;
    vtrace('market.quote.stale', 'violation', { i: 2 });
    const lines = out.parsed();
    expect(lines.filter((l) => !l.kind)).toHaveLength(5);
    expect(lines.find((l) => l.kind === 'summary')).toMatchObject({ check: 'market.quote.stale', outcome: 'violation', suppressed: 7, windowMs: 60_000 });
  });

  it('flushes pending summaries on demand (shutdown)', () => {
    const out = memory();
    configureValidationTrace({ env: { ...DEV, VALIDATION_TRACE_PER_MINUTE: '1' }, sink: out.sink, log: () => undefined });
    vtrace('a.b', 'ok');
    vtrace('a.b', 'ok');
    flushValidationTrace();
    expect(out.parsed().map((l) => l.kind ?? 'detail')).toEqual(['detail', 'summary']);
  });

  it('never throws: failing sink, failing lazy fields, bad names, oversized line', () => {
    configureValidationTrace({ env: DEV, sink: { write: () => { throw new Error('disk'); } }, log: () => undefined });
    expect(() => vtrace('a.b', 'ok')).not.toThrow();
    const out = memory();
    configureValidationTrace({ env: DEV, sink: out.sink, log: () => undefined });
    expect(() => vtrace('a.b', 'ok', () => { throw new Error('boom'); })).not.toThrow();
    expect(() => vtrace('Bad Name!', 'ok')).not.toThrow();
    expect(() => vtrace('a.b', 'maybe' as 'ok')).not.toThrow();
    vtrace('a.c', 'info', Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i}`, 'x '.repeat(100)])));
    expect(out.parsed().map((l) => [l.check, l.fields])).toEqual([['a.b', { fieldsError: true }], ['a.c', { _truncated: true }]]);
  });
});

describe('TraceFileSink', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsink-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sink = (overrides: Partial<ConstructorParameters<typeof TraceFileSink>[0]> = {}) =>
    new TraceFileSink({ dir, maxBytes: 1024 * 1024, retentionDays: 7, now: () => Date.parse('2026-11-11T10:00:00Z'), onFailure: () => undefined, ...overrides });

  it('stops cleanly at the daily cap with one capped marker', () => {
    const s = sink({ maxBytes: 300 });
    const results = Array.from({ length: 10 }, () => s.write(JSON.stringify({ check: 'a.b', pad: 'x'.repeat(80) })));
    const lines = fs.readFileSync(path.join(dir, 'validation-2026-11-11.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(lines.at(-1)).toMatchObject({ check: 'validation.trace.capped', outcome: 'info' });
    expect(lines.filter((l) => l.check === 'validation.trace.capped')).toHaveLength(1);
  });

  it('deletes only validation files older than the retention', () => {
    for (const name of ['validation-2026-01-01.jsonl', 'validation-2026-11-01.jsonl', 'validation-2026-11-05.jsonl', 'back-2026-01-01.log', 'validation-notes.txt']) {
      fs.writeFileSync(path.join(dir, name), '{}\n');
    }
    sink().write('{}');
    expect(fs.readdirSync(dir).sort()).toEqual(['back-2026-01-01.log', 'validation-2026-11-05.jsonl', 'validation-2026-11-11.jsonl', 'validation-notes.txt']);
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
