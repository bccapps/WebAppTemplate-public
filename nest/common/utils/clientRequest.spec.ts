/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it, jest } from '@jest/globals';
import type { Request } from 'express';
import { extractClientIp, extractClientMeta } from './clientRequest';
import { CookieConsentController } from '../controllers/CookieConsentController';
import type { CookieConsentService } from '../services/CookieConsentService';

const req = (ip: string | undefined, headers: Record<string, string> = {}, socketAddress?: string): Request =>
  ({ ip, headers, socket: { remoteAddress: socketAddress } }) as unknown as Request;

describe('extractClientIp', () => {
  it('uses req.ip (resolved through TRUST_PROXY), never the first X-Forwarded-For entry the client wrote', () => {
    expect(extractClientIp(req('203.0.113.50', { 'x-forwarded-for': '6.6.6.6, 203.0.113.50' }))).toBe('203.0.113.50');
  });

  it('falls back to the socket address, then null', () => {
    expect(extractClientIp(req(undefined, { 'x-forwarded-for': '6.6.6.6' }, '10.0.0.4'))).toBe('10.0.0.4');
    expect(extractClientIp(req(undefined, { 'x-forwarded-for': '6.6.6.6' }))).toBeNull();
  });

  it('feeds extractClientMeta', () => {
    const meta = extractClientMeta(req('198.51.100.7', { 'x-forwarded-for': '6.6.6.6', 'user-agent': 'ua' }));
    expect(meta).toEqual({ ipAddress: '198.51.100.7', userAgent: 'ua', referrer: null, acceptLanguage: null });
  });
});

describe('CookieConsentController', () => {
  it('logs req.ip, not a forged X-Forwarded-For', async () => {
    const log = jest.fn(async (_entry: unknown) => undefined);
    const controller = new CookieConsentController({ log } as unknown as CookieConsentService);
    const body = { categories: { necessary: true as const, audienceMeasurement: false } };
    await controller.log(body, req('198.51.100.7', { 'x-forwarded-for': '6.6.6.6', 'user-agent': 'ua' }));
    expect(log).toHaveBeenCalledWith({ ip: '198.51.100.7', userAgent: 'ua', categories: { necessary: true, audienceMeasurement: false } });
  });
});
