/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { AnonymousAuthProvider } from './AnonymousAuthProvider';
import {
  assertLocalTrustHost,
  allowedHostPorts,
  isLocalHostHeader,
  isLocalOrigin,
  isLocalTrustEnabled,
  isLocalTrustRequest,
  isLoopbackAddress,
  isLoopbackListenHost,
  type LocalTrustRequest,
} from './localTrust';

const ENV = { NODE_PORT: '3000' };
type Headers = Record<string, string>;

function req(remote: string, headers: Headers): LocalTrustRequest {
  return { socket: { remoteAddress: remote }, headers };
}

describe('isLocalTrustEnabled', () => {
  it('accepts true and 1 only', () => {
    expect(isLocalTrustEnabled({ LOCAL_TRUST: 'true' })).toBe(true);
    expect(isLocalTrustEnabled({ LOCAL_TRUST: ' 1 ' })).toBe(true);
    for (const v of [undefined, '', 'false', '0', 'yes']) expect(isLocalTrustEnabled({ LOCAL_TRUST: v })).toBe(false);
  });
});

describe('address helpers', () => {
  it('recognises loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ['192.168.1.2', '10.0.0.1', '::ffff:8.8.8.8', '', undefined, null, '127.0.0.1.evil.com']) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });

  it('recognises loopback listen hosts', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) expect(isLoopbackListenHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.5', 'example.com', '']) expect(isLoopbackListenHost(h)).toBe(false);
  });

  it('refuses a non-loopback HOST when local trust is on', () => {
    expect(() => assertLocalTrustHost('0.0.0.0', { LOCAL_TRUST: 'true' })).toThrow(/LOCAL_TRUST=true requires HOST/);
    expect(() => assertLocalTrustHost('127.0.0.1', { LOCAL_TRUST: 'true' })).not.toThrow();
    expect(() => assertLocalTrustHost('0.0.0.0', {})).not.toThrow();
  });
});

describe('isLocalHostHeader / isLocalOrigin', () => {
  it('checks the Host name and port', () => {
    for (const h of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000', 'LOCALHOST:3000']) expect(isLocalHostHeader(h, '3000')).toBe(true);
    for (const h of ['evil.com:3000', 'localhost:4000', 'localhost.evil.com:3000', '127.0.0.1.evil.com:3000', '', undefined]) {
      expect(isLocalHostHeader(h, '3000')).toBe(false);
    }
    expect(isLocalHostHeader('localhost:9999', undefined)).toBe(true);
  });

  it('accepts an absent or loopback http(s) Origin only', () => {
    for (const o of [undefined, 'http://localhost:5173', 'http://127.0.0.1:3000', 'https://[::1]:3000']) expect(isLocalOrigin(o)).toBe(true);
    for (const o of ['null', 'https://evil.com', 'http://localhost.evil.com', 'tauri://localhost', '', ['http://localhost']]) {
      expect(isLocalOrigin(o)).toBe(false);
    }
  });
});

describe('isLocalTrustRequest matrix', () => {
  const sockets = [
    ['local socket', '127.0.0.1', true],
    ['local IPv6 socket', '::1', true],
    ['remote socket', '203.0.113.9', false],
  ] as const;
  const hosts = [
    ['local Host', 'localhost:3000', true],
    ['foreign Host', 'evil.example:3000', false],
  ] as const;
  const origins = [
    ['no Origin', undefined, true],
    ['local Origin', 'http://localhost:5173', true],
    ['foreign Origin', 'https://evil.example', false],
  ] as const;

  for (const [sn, addr, sOk] of sockets) {
    for (const [hn, host, hOk] of hosts) {
      for (const [on, origin, oOk] of origins) {
        const expected = sOk && hOk && oOk;
        it(`${sn} + ${hn} + ${on} -> ${expected ? 'trusted' : 'anonymous'}`, () => {
          const headers: Headers = { host };
          if (origin) headers.origin = origin;
          expect(isLocalTrustRequest(req(addr, headers), ENV)).toBe(expected);
        });
      }
    }
  }

  it('ignores a forged X-Forwarded-For claiming loopback on a remote socket', () => {
    expect(isLocalTrustRequest(req('203.0.113.9', { host: 'localhost:3000', 'x-forwarded-for': '127.0.0.1' }), ENV)).toBe(false);
  });

  it('refuses any proxied request, even from a loopback socket', () => {
    for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded']) {
      expect(isLocalTrustRequest(req('127.0.0.1', { host: 'localhost:3000', [h]: '8.8.8.8' }), ENV)).toBe(false);
    }
  });

  it('refuses a missing socket or Host', () => {
    expect(isLocalTrustRequest({ headers: { host: 'localhost:3000' } }, ENV)).toBe(false);
    expect(isLocalTrustRequest(req('127.0.0.1', {}), ENV)).toBe(false);
  });
});

describe('FRONT_PORT in development', () => {
  const dev = { NODE_PORT: '3000', FRONT_PORT: '5173', APP_ENV: 'dev' };
  const viaVite = req('127.0.0.1', { host: 'localhost:5173', origin: 'http://localhost:5173' });

  it('accepts the front port only when APP_ENV=dev', () => {
    expect(isLocalTrustRequest(viaVite, dev)).toBe(true);
    for (const appEnv of [undefined, 'prod', 'preprod', '']) {
      expect(isLocalTrustRequest(viaVite, { ...dev, APP_ENV: appEnv })).toBe(false);
    }
  });

  it('still accepts NODE_PORT and refuses other ports in dev', () => {
    expect(isLocalTrustRequest(req('127.0.0.1', { host: 'localhost:3000' }), dev)).toBe(true);
    expect(isLocalTrustRequest(req('127.0.0.1', { host: 'localhost:9999' }), dev)).toBe(false);
  });

  it('does not loosen the other checks on the front port', () => {
    expect(isLocalTrustRequest(req('203.0.113.9', { host: 'localhost:5173' }), dev)).toBe(false);
    expect(isLocalTrustRequest(req('127.0.0.1', { host: 'evil.example:5173' }), dev)).toBe(false);
    expect(isLocalTrustRequest(req('127.0.0.1', { host: 'localhost:5173', origin: 'https://evil.example' }), dev)).toBe(false);
    expect(isLocalTrustRequest(req('127.0.0.1', { host: 'localhost:5173', 'x-forwarded-for': '127.0.0.1' }), dev)).toBe(false);
  });

  it('computes the allowed ports', () => {
    expect(allowedHostPorts({ NODE_PORT: '3000', FRONT_PORT: '5173' })).toEqual(['3000']);
    expect(allowedHostPorts(dev)).toEqual(['3000', '5173']);
    expect(allowedHostPorts({ APP_ENV: 'dev', FRONT_PORT: '5173' })).toEqual([]);
  });
});

describe('AnonymousAuthProvider local trust', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const local = req('127.0.0.1', { host: 'localhost:3000' });

  it('grants the local-trust administrator when enabled on loopback', () => {
    Object.assign(process.env, { LOCAL_TRUST: 'true', HOST: '127.0.0.1', NODE_PORT: '3000' });
    expect(new AnonymousAuthProvider().resolveRequest(local)).toEqual({ id: 0, admin: true, kind: 'local-trust' });
  });

  it('grants nothing without LOCAL_TRUST', () => {
    Object.assign(process.env, { HOST: '127.0.0.1', NODE_PORT: '3000' });
    delete process.env.LOCAL_TRUST;
    expect(new AnonymousAuthProvider().resolveRequest(local)).toBeNull();
  });

  it('refuses to start with HOST=0.0.0.0', () => {
    Object.assign(process.env, { LOCAL_TRUST: 'true', HOST: '0.0.0.0' });
    expect(() => new AnonymousAuthProvider()).toThrow(/LOCAL_TRUST=true requires HOST/);
  });

  it('refuses to start when HOST is unset (default 0.0.0.0)', () => {
    Object.assign(process.env, { LOCAL_TRUST: 'true' });
    delete process.env.HOST;
    expect(() => new AnonymousAuthProvider()).toThrow(/LOCAL_TRUST=true requires HOST/);
  });
});
