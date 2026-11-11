/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { createHash, randomBytes } from 'crypto';
import { maskEmailAddresses } from '../services/EmailService';
import { leaksSecret as leaks, mustNotLeakCases, mustStayHiddenCases, secretFixtures } from './secretFixtures.testkit';
import {
  REDACTED, TRACE_LIMITS, deriveFingerprintKey, fingerprint, isPersonalKey, isSensitiveKey, sanitizeTraceFields, sanitizeTraceString, setFingerprintKey,
} from './traceSanitizer';

const HIDDEN = /^hmac:[0-9a-f]{16};len=\d+$/;

describe('sanitizeTraceString', () => {
  it.each(Object.entries(secretFixtures()))('replaces a %s by its keyed fingerprint and length', (_name, secret) => {
    for (const text of [secret, `failed with ${secret} for user 42`, `"${secret}"`, `ref#${secret}!`, `id:${secret}@x`, `a.b/${secret}`]) {
      const out = sanitizeTraceString(text);
      expect(out).toMatch(HIDDEN);
      expect(leaks(out, secret)).toBe(false);
    }
  });

  it.each(mustStayHiddenCases())('MUST_STAY_HIDDEN: %s', (_name, value) => {
    expect(sanitizeTraceString(value)).toMatch(HIDDEN);
    expect(sanitizeTraceString(`seen ${value} here`)).toMatch(HIDDEN);
  });

  it('replaces anything longer than 1 KiB without examining it', () => {
    expect(sanitizeTraceString('word '.repeat(300))).toMatch(HIDDEN);
  });

  it('masks plain e-mail addresses, fingerprints pseudo-addresses (text after @ is often a password)', () => {
    expect(sanitizeTraceString('sent to jean.dupont@example.fr')).toBe('sent to j***@example.fr');
    expect(sanitizeTraceString('Summer@abcd1234')).toMatch(HIDDEN);
  });

  it('keeps ordinary text readable and drops control, C1, bidi and zero-width characters', () => {
    for (const text of ['otp', 'expired', 'GET /api/v1/users/me', '2026-11-11T10:00:00.000Z', 'user 42 refused: step-up missing', 'ValidationTraceController']) {
      expect(sanitizeTraceString(text)).toBe(text);
    }
    expect(sanitizeTraceString('a\nb\r\u2028c\u0085d\u202ee\u200bf')).toBe('a b  c def');
    expect(sanitizeTraceString('ok: 1, '.repeat(50))).toMatch(/…\[\+150\]$/);
  });

  it('stays below 100 ms on hostile 100 KB and 1 KB inputs (no ReDoS)', () => {
    const shapes = ['a', 'eyJ', 'eyJaaaa.', 'ab+', 'a://b:', '!', 'x@', 'password: ', 'a.b/', ' ', '1 ', 'a:', '%41', 'Ab1+', 'é'];
    for (const unit of shapes) {
      for (const size of [100_000, 1_020]) {
        const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
        const t0 = performance.now();
        sanitizeTraceString(text);
        expect(performance.now() - t0).toBeLessThan(100);
      }
    }
    const t0 = performance.now();
    maskEmailAddresses('!'.repeat(100_000));
    maskEmailAddresses(`x@${'a.'.repeat(50_000)}`);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('never lets random standard base64 of 18 bytes through (500 draws)', () => {
    for (let i = 0; i < 500; i += 1) expect(sanitizeTraceString(randomBytes(18).toString('base64'))).toMatch(HIDDEN);
  });
});

describe('field names', () => {
  it.each(['password', 'pass', 'newPass', 'pass_confirm', 'pw', 'pwd', 'mdp', 'creds', 'sid', 'sig', 'nonce', 'apiKey', 'x-api-key', 'privateKey', 'secret',
    'accessToken', 'authorization', 'cookie', 'sessionId', 'proof', 'otpCode', 'code', 'otp', 'signature', 'seed', 'mnemonic', 'pin', 'walletPin', 'cvv', 'cvc',
    'card', 'cc', 'pan', 'phrase', 'verification', 'entered', 'csrf', 'hmac', 'jwt'])('%s is sensitive', (key) => expect(isSensitiveKey(key)).toBe(true));
  it.each(['statusCode', 'errorCode', 'countryCode', 'method', 'reason', 'attempts', 'userId', 'module', 'author', 'monkey', 'passenger'])('%s is not', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
  it.each(['email', 'phone', 'userIp', 'remoteAddr', 'ipAddr', 'ips', 'ip', 'tel', 'mobile', 'name', 'firstName', 'address', 'dob', 'birthDate', 'login', 'iban'])(
    '%s is personal data', (key) => expect(isPersonalKey(key)).toBe(true),
  );
});

describe('sanitizeTraceFields with "*" rules (the safety net)', () => {
  it.each(mustNotLeakCases())('MUST_NOT_LEAK: %s', (_name, fields, secret) => {
    const out = JSON.stringify(sanitizeTraceFields(fields, '*'));
    expect(leaks(out, secret)).toBe(false);
  });

  it('never lets a fixture secret out, whatever the key or the position', () => {
    const fixtures = secretFixtures();
    const fields: Record<string, unknown> = {};
    for (const [name, secret] of Object.entries(fixtures)) fields[`message_${name}`] = `rejected ${secret} (retry)`;
    Object.assign(fields, { list: [fixtures.jwt, 'ok'], amount: 123456 });
    const out = JSON.stringify(sanitizeTraceFields(fields, '*'));
    for (const secret of Object.values(fixtures)) expect(leaks(out, secret)).toBe(false);
  });

  it('redacts sensitive names (length only), fingerprints personal data, keeps booleans and null', () => {
    const out = sanitizeTraceFields({ password: 'hunter2', otpCode: 123456, sessionId: null, hasToken: true, cookie: { a: 1 }, email: 'a@b.fr' }, '*');
    expect(out).toEqual({ password: '[redacted:7]', otpCode: REDACTED, sessionId: null, hasToken: true, cookie: REDACTED, email: fingerprint('a@b.fr') });
  });

  it('keeps simple types only, caps fields, drops odd or secret-looking keys, never throws', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const out = sanitizeTraceFields({ ...JSON.parse('{"__proto__":{"x":1},"a b":1}'), nested: { a: 1 }, fn: () => 1, err: new Error('token=abc'), ...many }, '*');
    expect(out).toMatchObject({ nested: '[object]', fn: '[function]', err: '[error]' });
    expect(Object.keys(out)).toHaveLength(TRACE_LIMITS.maxFields + 1);
    const hostile = Object.defineProperty({}, 'boom', { enumerable: true, get: () => { throw new Error('nope'); } });
    expect(sanitizeTraceFields(hostile, '*')).toEqual({ _droppedFields: 1 });
    expect(sanitizeTraceFields(null, '*')).toEqual({});
  });
});

describe('sanitizeTraceFields with declared rules (checks.json "fields")', () => {
  const rules = { method: ['email', 'sms'], attempts: 'number', ok: 'boolean', detail: 'string', userRef: 'id' } as const;

  it('keeps only the declared fields, with their declared types', () => {
    const out = sanitizeTraceFields({ method: 'email', attempts: 3, ok: true, detail: 'late', userRef: 42, extra: 'x', password: 'p' }, rules);
    expect(out).toEqual({ method: 'email', attempts: 3, ok: true, detail: 'late', userRef: fingerprint('42'), _droppedFields: 2 });
  });

  it('drops a value of the wrong type or outside its enumeration, and still applies the safety net', () => {
    const { appToken } = secretFixtures();
    const out = sanitizeTraceFields({ method: 'fax', attempts: '3', ok: 'yes', detail: `copied ${appToken}` }, rules);
    expect(out).toEqual({ detail: expect.stringMatching(HIDDEN), _droppedFields: 3 });
  });

  it('drops every field of an undeclared trace (null rules)', () => {
    expect(sanitizeTraceFields({ a: 1, b: 'x' }, null)).toEqual({ _droppedFields: 2 });
  });
});

describe('keyed fingerprints', () => {
  it('are HMACs of 16 hex characters: an unkeyed hash of the value does not match them', () => {
    setFingerprintKey(randomBytes(32));
    const value = '1987-06-23';
    expect(fingerprint(value)).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(fingerprint(value)).not.toContain(createHash('sha256').update(value).digest('hex').slice(0, 8));
  });

  it('cannot be reversed by enumeration without the key (birth date, phone)', () => {
    setFingerprintKey(randomBytes(32));
    const traced = sanitizeTraceFields({ birthDate: '1987-06-23' }, '*').birthDate;
    setFingerprintKey(randomBytes(32)); // the attacker's guess of the key
    let found = false;
    for (let d = Date.UTC(1980, 0, 1); d < Date.UTC(1995, 0, 1) && !found; d += 86_400_000) found = fingerprint(new Date(d).toISOString().slice(0, 10)) === traced;
    expect(found).toBe(false);
  });

  it('derive a stable key from CRYPT_DB_MASTER_KEY per project and environment, random without it', () => {
    const master = randomBytes(32).toString('base64');
    const a = deriveFingerprintKey({ CRYPT_DB_MASTER_KEY: master, PROJECT_NAME: 'p', APP_ENV: 'dev' });
    expect(deriveFingerprintKey({ CRYPT_DB_MASTER_KEY: master, PROJECT_NAME: 'p', APP_ENV: 'dev' }).equals(a)).toBe(true);
    expect(deriveFingerprintKey({ CRYPT_DB_MASTER_KEY: master, PROJECT_NAME: 'p', APP_ENV: 'preprod' }).equals(a)).toBe(false);
    expect(deriveFingerprintKey({}).equals(deriveFingerprintKey({}))).toBe(false);
  });
});
