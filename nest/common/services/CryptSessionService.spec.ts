/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import { randomBytes, createECDH } from 'crypto';
import { CryptSessionService } from './CryptSessionService';
import { RedisService } from './RedisService';
import type { ConfigurationService } from './ConfigurationService';
import { DEFAULT_MAX_LIVE_SESSIONS } from '../constants/crypt.constants';

// PERFORMANCE_PLAN.md §7.9, étape 1: CryptSessionService now consumes the
// shared RedisService instead of managing its own ioredis client — its
// public API (createSession/peekSession/requireSession/getServerPublicKey/
// getSessionTtlMs) must stay unchanged (TransportCryptInterceptor depends on
// it), and the in-memory fallback (fail-open) must keep working exactly as
// before whenever Redis isn't configured/available.
describe('CryptSessionService (§7.9)', () => {
  const makeRedisService = (client: any) => ({ getClient: () => client, isConfigured: () => client !== null } as unknown as RedisService);

  const clientPublicKeyB64 = (() => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return ecdh.getPublicKey(undefined, 'uncompressed').toString('base64');
  })();

  beforeAll(() => {
    process.env.CRYPT_SESSION_PRIVATE_KEY = randomBytes(32).toString('base64');
  });

  it('creates and resolves a session in memory when no Redis client is configured (fail-open)', async () => {
    const service = new CryptSessionService(makeRedisService(null));
    const { sessionId } = await service.createSession(clientPublicKeyB64);
    const session = await service.peekSession(sessionId);
    expect(session).not.toBeNull();
  });

  it('stores (capped Lua script) and loads a session via the injected Redis client when configured', async () => {
    const backing = new Map<string, string>();
    const client = {
      eval: jest.fn((_script: string, _numKeys: number, sessionKey: string, _indexKey: string, value: string) => {
        backing.set(sessionKey, value);
        return Promise.resolve(0);
      }),
      get: jest.fn((key: string) => Promise.resolve(backing.has(key) ? backing.get(key)! : null)),
    };
    const service = new CryptSessionService(makeRedisService(client));
    const { sessionId } = await service.createSession(clientPublicKeyB64);

    expect(client.eval).toHaveBeenCalledTimes(1);
    const session = await service.peekSession(sessionId);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(session).not.toBeNull();
  });

  it('passes the keys, the TTL and the configured cap to the Redis script', async () => {
    const client = { eval: jest.fn((..._args: unknown[]) => Promise.resolve(3)), get: jest.fn() };
    const config = { get: (key: string) => (key === 'common_cryptSessionMaxLive' ? '1234' : undefined) } as unknown as ConfigurationService;
    const service = new CryptSessionService(makeRedisService(client), config);
    const before = Date.now();
    const { sessionId } = await service.createSession(clientPublicKeyB64);
    const args = client.eval.mock.calls[0];
    const ttlMs = service.getSessionTtlMs();
    expect(args[1]).toBe(2);
    expect(args.slice(2, 4)).toEqual([`crypt:session:${sessionId}`, 'crypt:session-index']);
    expect(args[5]).toBe(Math.ceil(ttlMs / 1000));
    expect(args[6]).toBeGreaterThanOrEqual(before);
    expect((args[6] as number) - (args[7] as number)).toBe(Math.ceil(ttlMs / 1000) * 1000);
    expect(args.slice(8)).toEqual([1234, sessionId, 'crypt:session:', Math.ceil(ttlMs / 1000) * 1000]);
  });

  it('fails open: falls back to in-memory storage when the Redis client throws', async () => {
    const client = {
      eval: jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
      get: jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    };
    const service = new CryptSessionService(makeRedisService(client));
    const { sessionId } = await service.createSession(clientPublicKeyB64);
    const session = await service.peekSession(sessionId);
    expect(session).not.toBeNull();
  });

  it('requireSession throws for a missing/expired session, in both storage modes', async () => {
    const service = new CryptSessionService(makeRedisService(null));
    await expect(service.requireSession('does-not-exist')).rejects.toThrow();
  });

  describe('cap on live sessions (POST /crypt/session is anonymous)', () => {
    const withCap = (cap: unknown) => ({ get: (key: string) => (key === 'common_cryptSessionMaxLive' ? cap : undefined) }) as unknown as ConfigurationService;

    it('reads common_cryptSessionMaxLive, with the default for a missing or invalid value', () => {
      expect(new CryptSessionService(makeRedisService(null), withCap('250')).getMaxLiveSessions()).toBe(250);
      expect(new CryptSessionService(makeRedisService(null), withCap('0')).getMaxLiveSessions()).toBe(DEFAULT_MAX_LIVE_SESSIONS);
      expect(new CryptSessionService(makeRedisService(null), withCap('abc')).getMaxLiveSessions()).toBe(DEFAULT_MAX_LIVE_SESSIONS);
      expect(new CryptSessionService(makeRedisService(null)).getMaxLiveSessions()).toBe(DEFAULT_MAX_LIVE_SESSIONS);
    });

    it('in memory, evicts the oldest live sessions past the cap and keeps the newest', async () => {
      const service = new CryptSessionService(makeRedisService(null), withCap(3));
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push((await service.createSession(clientPublicKeyB64)).sessionId);
      const alive = await Promise.all(ids.map(async (id) => (await service.peekSession(id)) !== null));
      expect(alive).toEqual([false, false, true, true, true]);
      expect((service as unknown as { localSessions: Map<string, unknown> }).localSessions.size).toBe(3);
    });

    it('in memory, drops expired sessions first (no live one evicted while expired ones fill the cap)', async () => {
      const previousTtl = process.env.CRYPT_SESSION_TTL_MS;
      const now = jest.spyOn(Date, 'now');
      try {
        process.env.CRYPT_SESSION_TTL_MS = '1000';
        const service = new CryptSessionService(makeRedisService(null), withCap(2));
        now.mockReturnValue(1_000_000);
        const old = [(await service.createSession(clientPublicKeyB64)).sessionId, (await service.createSession(clientPublicKeyB64)).sessionId];
        now.mockReturnValue(1_005_000);
        const fresh = [(await service.createSession(clientPublicKeyB64)).sessionId, (await service.createSession(clientPublicKeyB64)).sessionId];
        const sessions = (service as unknown as { localSessions: Map<string, unknown> }).localSessions;
        expect([...sessions.keys()]).toEqual(fresh);
        expect(await service.peekSession(old[0])).toBeNull();
      } finally {
        now.mockRestore();
        if (previousTtl === undefined) delete process.env.CRYPT_SESSION_TTL_MS;
        else process.env.CRYPT_SESSION_TTL_MS = previousTtl;
      }
    });
  });
});
