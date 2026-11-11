/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { leaksSecret as leaks, secretFixtures } from './secretFixtures.testkit';
import { REDACTED, TRACE_LIMITS, fingerprint, isSensitiveKey, sanitizeTraceFields, sanitizeTraceString } from './traceSanitizer';

describe('sanitizeTraceString', () => {
  it.each(Object.entries(secretFixtures()))('replaces a %s by its fingerprint and length', (_name, secret) => {
    for (const text of [secret, `failed with ${secret} for user 42`, `"${secret}"`, `ref#${secret}!`, `id:${secret}@x`, `a.b/${secret}`]) {
      const out = sanitizeTraceString(text);
      expect(out).toMatch(/^sha256:[0-9a-f]{8};len=\d+$/);
      expect(leaks(out, secret)).toBe(false);
    }
  });

  it('is stable: the same value gives the same fingerprint (correlation without the value)', () => {
    const { appToken } = secretFixtures();
    expect(sanitizeTraceString(appToken)).toBe(sanitizeTraceString(appToken));
    expect(sanitizeTraceString(appToken)).toBe(`${fingerprint(appToken)};len=${appToken.length}`);
  });

  it('masks e-mail addresses and keeps ordinary text readable', () => {
    expect(sanitizeTraceString('sent to jean.dupont@example.fr')).toBe('sent to j***@example.fr');
    for (const text of ['otp', 'expired', 'GET /api/v1/users/me', '2026-11-11T10:00:00.000Z', 'user 42 refused: step-up missing']) {
      expect(sanitizeTraceString(text)).toBe(text);
    }
  });

  it('drops control characters (no log injection) and caps the length', () => {
    expect(sanitizeTraceString('a\nb\r\u2028c')).toBe('a b  c');
    const long = 'word '.repeat(100);
    const out = sanitizeTraceString(long);
    expect(out.startsWith(long.slice(0, TRACE_LIMITS.maxStringLength))).toBe(true);
    expect(out).toMatch(/…\[\+300\]$/);
  });
});

describe('isSensitiveKey', () => {
  it.each(['password', 'passwd', 'pphrase', 'apiKey', 'x-api-key', 'privateKey', 'secret', 'clientSecret', 'accessToken', 'authorization',
    'cookie', 'sessionId', 'proof', 'otpCode', 'code', 'otp', 'signature', 'seed', 'mnemonic', 'pin', 'walletPin', 'credentials', 'jwt'])(
    '%s is sensitive', (key) => expect(isSensitiveKey(key)).toBe(true),
  );
  it.each(['statusCode', 'errorCode', 'countryCode', 'method', 'reason', 'attempts', 'userId', 'module'])('%s is not', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('sanitizeTraceFields', () => {
  it('never lets a fixture secret out, whatever the key or the position', () => {
    const fixtures = secretFixtures();
    const fields: Record<string, unknown> = {};
    for (const [name, secret] of Object.entries(fixtures)) {
      fields[`plain_${name}`] = secret;
      fields[`message_${name}`] = `rejected ${secret} (retry)`;
    }
    Object.assign(fields, { password: fixtures.hex64, apiKey: fixtures.appToken, otpCode: 123456, authorization: fixtures.bearer, list: [fixtures.jwt, 'ok'] });
    const out = JSON.stringify(sanitizeTraceFields(fields));
    for (const secret of Object.values(fixtures)) expect(leaks(out, secret)).toBe(false);
    expect(out).not.toContain('123456');
  });

  it('redacts sensitive names (length only for strings), keeps booleans and null', () => {
    const out = sanitizeTraceFields({ password: 'hunter2', otpCode: 123456, sessionId: null, hasToken: true, cookie: { a: 1 } });
    expect(out).toEqual({ password: '[redacted:7]', otpCode: REDACTED, sessionId: null, hasToken: true, cookie: REDACTED });
  });

  it('fingerprints personal data and masks e-mails in free text', () => {
    const out = sanitizeTraceFields({ email: 'jean.dupont@example.fr', phone: '+33 6 12 34 56 78', note: 'from jean.dupont@example.fr' });
    expect(out.email).toBe(fingerprint('jean.dupont@example.fr'));
    expect(out.phone).toBe(fingerprint('+33 6 12 34 56 78'));
    expect(out.note).toBe('from j***@example.fr');
  });

  it('keeps simple types only: no nested object, no function, bounded arrays', () => {
    const items = Array.from({ length: 15 }, (_, i) => i);
    const out = sanitizeTraceFields({
      nested: { password: 'x', deep: { a: 1 } }, fn: () => 1, items, when: new Date(0), err: new Error('token=abc123def'), big: BigInt(7), nan: Number.NaN, n: 3,
    });
    expect(out.nested).toBe('[object]');
    expect(out.fn).toBe('[function]');
    expect(out.items).toEqual([...items.slice(0, 10), '[+5]']);
    expect(out.when).toBe('1970-01-01T00:00:00.000Z');
    expect(out.err).toBe('[error Error]');
    expect(out.big).toBe('7');
    expect(out.nan).toBeNull();
    expect(out.n).toBe(3);
  });

  it('caps the number of fields and drops odd key names', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const out = sanitizeTraceFields({ ...JSON.parse('{"__proto__":{"x":1},"a b":1}'), ...many });
    expect(Object.keys(out)).toHaveLength(TRACE_LIMITS.maxFields + 1);
    expect(out._droppedFields).toBe(8);
    expect(out).not.toHaveProperty('a b');
  });

  it('accepts anything without throwing', () => {
    const hostile = Object.defineProperty({}, 'boom', { enumerable: true, get: () => { throw new Error('nope'); } });
    expect(sanitizeTraceFields(hostile)).toEqual({ _droppedFields: 1 });
    expect(sanitizeTraceFields(null)).toEqual({});
    expect(sanitizeTraceFields('text')).toEqual({});
    expect(sanitizeTraceFields([1, 2])).toEqual({});
  });
});
