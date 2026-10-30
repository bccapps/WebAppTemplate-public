/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it } from '@jest/globals';
import { randomBytes, randomUUID } from 'crypto';
import { isSecretSegment, MAX_LOGGED_PATH_LENGTH, redactPath, redactUrlIn } from './redactPath';

const b64 = () => randomBytes(32).toString('base64url');
const hex = () => randomBytes(32).toString('hex');

describe('redactPath', () => {
  it.each([
    ['/api/v1/communications/webhook/brevo/' + 'A1b2C3d4E5f6G7h8I9j0K1', '/api/v1/communications/webhook/brevo/[redacted]'],
    ['/api/v1/agenthub/hooks/42/' + 'k9Fz3QpL0mWx7TbR2sVyN8', '/api/v1/agenthub/hooks/42/[redacted]'],
    ['/api/v1/agenthub/share-info/acs_abcdefgh', '/api/v1/agenthub/share-info/[redacted]'],
    ['/api/v1/issue-intake/ahi_short123', '/api/v1/issue-intake/[redacted]'],
    ['/api/v1/runners/enroll/ahe_Zx91', '/api/v1/runners/enroll/ahe_Zx91'],
    ['/api/v1/x/webhook?token=secret&a=1', '/api/v1/x/webhook'],
    ['/api/v1/x#frag', '/api/v1/x'],
    ['/api/v1/agenthub/me/notification-channels/webhook', '/api/v1/agenthub/me/notification-channels/webhook'],
    ['/api/v1/admin/users/communication-topics/12', '/api/v1/admin/users/communication-topics/12'],
    ['/api/v1/wallet-intelligence-v2/webhooks/evm/8453', '/api/v1/wallet-intelligence-v2/webhooks/evm/8453'],
    ['/api/v1/crypt/session', '/api/v1/crypt/session'],
    ['', ''],
  ])('%p → %p', (url, expected) => {
    expect(redactPath(url)).toBe(expected);
  });

  it('redacts random tokens whatever their encoding, and UUIDs (same shape as a capability token)', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(redactPath(`/api/v1/communications/unsubscribe/${b64()}`)).toBe('/api/v1/communications/unsubscribe/[redacted]');
      expect(redactPath(`/t/${hex()}/p.gif`)).toBe('/t/[redacted]/p.gif');
      expect(redactPath(`/api/v1/agenthub/sessions/${randomUUID()}`)).toBe('/api/v1/agenthub/sessions/[redacted]');
    }
  });

  it('decodes a percent-encoded segment before judging it, keeps null/undefined safe and caps the length', () => {
    expect(redactPath(`/x/${encodeURIComponent('sk_live_abcdefgh12')}`)).toBe('/x/[redacted]');
    expect(redactPath('/x/%E0%A4%A')).toBe('/x/%E0%A4%A');
    expect(redactPath(undefined)).toBe('');
    const long = redactPath(`/${'segment/'.repeat(60)}`);
    expect(long.length).toBe(MAX_LOGGED_PATH_LENGTH + 1);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps short ids and words, and long all-lowercase route words', () => {
    expect(isSecretSegment('12345')).toBe(false);
    expect(isSecretSegment('project-creation-defaults')).toBe(false);
    expect(isSecretSegment('acs_')).toBe(false);
  });
});

describe('redactUrlIn', () => {
  it("redacts the URL quoted by Nest's 404 message and by an exception detail", () => {
    const secret = b64();
    const raw = `/api/v1/agenthub/hooks/7/${secret}?x=${secret}`;
    expect(redactUrlIn(`Cannot GET ${raw}`, raw)).toBe('Cannot GET /api/v1/agenthub/hooks/7/[redacted]');
    const detail = JSON.stringify({ message: `Cannot GET /api/v1/agenthub/hooks/7/${secret}`, error: 'Not Found' });
    expect(redactUrlIn(detail, raw)).not.toContain(secret);
    expect(redactUrlIn('nothing to hide', raw)).toBe('nothing to hide');
    expect(redactUrlIn('text', undefined)).toBe('text');
  });
});
