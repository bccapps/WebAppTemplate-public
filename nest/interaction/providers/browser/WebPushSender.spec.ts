/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * `WebPushSender` at the module boundary: every way `web-push` (replaced by a fake library: no network) or the guard
 * can fail becomes a code; the endpoint (a target, close to a capability URL) never appears in the result nor in any
 * log, whatever the library's error carries (`WebPushError` holds the endpoint and the response body).
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger, type LoggerService } from '@nestjs/common';
import https from 'https';
import { isBlockedAddress, NetGuardError, type AddressGuard } from '../../utils/netGuard';
import { WEB_PUSH_MAX_RESPONSE_BYTES, WebPushSender, type WebPushLibrary } from './WebPushSender';

const ENDPOINT = 'https://push.example.test/send/abc-endpoint-secret-0001';
const LEAKS = ['abc-endpoint-secret', 'push.example.test', 'P256DH-KEY-SECRET', 'AUTH-SECRET'];
const TARGET = { endpoint: ENDPOINT, p256dh: 'P256DH-KEY-SECRET', auth: 'AUTH-SECRET' };
const VAPID = { subject: 'mailto:ops@example.test', publicKey: 'BPub', privateKey: 'VAPID-PRIVATE-SECRET' };
const PUBLIC: AddressGuard = { allowPrivate: false, isBlocked: isBlockedAddress, resolve: async () => [{ address: '93.184.216.34', family: 4 }] };

const lines: string[] = [];
class CapturingLogger implements LoggerService {
  log(...parts: unknown[]): void {
    lines.push(parts.map(String).join(' '));
  }
  error(...parts: unknown[]): void {
    lines.push(parts.map(String).join(' '));
  }
  warn(...parts: unknown[]): void {
    lines.push(parts.map(String).join(' '));
  }
}

class TestSender extends WebPushSender {
  constructor(
    private readonly lib: WebPushLibrary | null,
    private readonly testGuard: AddressGuard = PUBLIC,
  ) {
    super();
  }
  protected override guard(): AddressGuard {
    return this.testGuard;
  }
  protected override library(): Promise<WebPushLibrary | null> {
    return Promise.resolve(this.lib);
  }
}

const failing = (error: unknown): WebPushLibrary => ({ sendNotification: () => Promise.reject(error) });

beforeEach(() => {
  lines.length = 0;
  Logger.overrideLogger(new CapturingLogger());
  for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) jest.spyOn(console, name).mockImplementation((...parts: unknown[]) => void lines.push(parts.map(String).join(' ')));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('WebPushSender: failures become codes, the endpoint never leaks', () => {
  const webPushError = (statusCode: number): Error => Object.assign(new Error('Received unexpected response code'), { name: 'WebPushError', statusCode, headers: {}, body: `gone: ${ENDPOINT}`, endpoint: ENDPOINT });
  const cases: Array<[string, WebPushLibrary, string, number | null]> = [
    ['410 Gone (WebPushError with the endpoint and body)', failing(webPushError(410)), 'HTTP_410', 410],
    ['404 Not Found', failing(webPushError(404)), 'HTTP_404', 404],
    ['429 Too Many Requests', failing(webPushError(429)), 'HTTP_429', 429],
    ['500 from the push service', failing(webPushError(500)), 'HTTP_500', 500],
    ['network error quoting the endpoint', failing(Object.assign(new Error(`connect ECONNREFUSED 93.184.216.34:443 ${ENDPOINT}`), { code: 'ECONNREFUSED' })), 'NETWORK', null],
    ['socket timeout of web-push', failing(new Error('Socket timeout')), 'TIMEOUT', null],
    ['abort quoting the endpoint', failing(Object.assign(new Error(`aborted ${ENDPOINT}`), { name: 'AbortError' })), 'TIMEOUT', null],
    ['ETIMEDOUT', failing(Object.assign(new Error(`ETIMEDOUT ${ENDPOINT}`), { code: 'ETIMEDOUT' })), 'TIMEOUT', null],
    ['the guard at connection time (rebinding)', failing(new NetGuardError('ADDRESS_REFUSED')), 'ADDRESS_REFUSED', null],
    ['the socket bound (stream without end)', failing(new NetGuardError('NETWORK')), 'NETWORK', null],
    ['a nonsense status code', failing(Object.assign(new Error(ENDPOINT), { statusCode: 99999 })), 'NETWORK', null],
    ['a non-Error rejection', failing(ENDPOINT), 'NETWORK', null],
    [
      'a library that throws synchronously',
      {
        sendNotification: () => {
          throw new Error(`invalid subscription ${ENDPOINT}`);
        },
      },
      'NETWORK',
      null,
    ],
  ];

  for (const [name, lib, code, status] of cases) {
    it(name, async () => {
      const result = await new TestSender(lib).send(TARGET, '{"title":"x"}', VAPID, 1000);
      expect(result).toEqual({ ok: false, status, code });
      const text = [JSON.stringify(result), ...lines].join('\n');
      for (const leak of [...LEAKS, VAPID.privateKey]) expect(text).not.toContain(leak);
    });
  }

  it('refusals before any call: http, a blocked literal, an unresolvable or private name, no library', async () => {
    const send = (endpoint: string, sender: WebPushSender = new TestSender({ sendNotification: async () => ({ statusCode: 201 }) })) => sender.send({ ...TARGET, endpoint }, '{}', VAPID, 1000);
    expect(await send('http://push.example.test/x')).toMatchObject({ ok: false, code: 'ADDRESS_REFUSED' });
    expect(await send('https://169.254.169.254/x')).toMatchObject({ ok: false, code: 'ADDRESS_REFUSED' });
    expect(await send('not a url at all')).toMatchObject({ ok: false, code: 'ADDRESS_REFUSED' });
    expect(await send(ENDPOINT, new TestSender(null, { ...PUBLIC, resolve: async () => Promise.reject(new Error(`ENOTFOUND ${ENDPOINT}`)) }))).toMatchObject({ ok: false, code: 'ADDRESS_REFUSED' });
    expect(await send(ENDPOINT, new TestSender(null, { ...PUBLIC, resolve: async () => [{ address: '10.0.0.1', family: 4 }] }))).toMatchObject({ ok: false, code: 'ADDRESS_REFUSED' });
    expect(await send(ENDPOINT, new TestSender(null))).toEqual({ ok: false, status: null, code: 'NOT_CONFIGURED' });
    for (const leak of LEAKS) expect(lines.join('\n')).not.toContain(leak);
  });

  it('hands web-push the URL the guard judged and a bounded, guarded agent', async () => {
    const seen: Array<{ endpoint: string; agent: unknown; timeout: number }> = [];
    const lib: WebPushLibrary = {
      sendNotification: async (subscription, _payload, options) => {
        seen.push({ endpoint: subscription.endpoint, agent: options.agent, timeout: options.timeout });
        return { statusCode: 201 };
      },
    };
    expect(await new TestSender(lib).send({ ...TARGET, endpoint: 'https://PUSH.example.test:443/send/a%2Fb' }, '{}', VAPID, 1234)).toEqual({ ok: true, status: 201, code: null });
    expect(seen[0].endpoint).toBe('https://push.example.test/send/a%2Fb');
    expect(seen[0].agent).toBeInstanceOf(https.Agent);
    expect((seen[0].agent as unknown as { limits: unknown }).limits).toEqual({ deadlineMs: 1234, maxBytes: WEB_PUSH_MAX_RESPONSE_BYTES });
    expect(seen[0].timeout).toBe(1234);
  });
});
