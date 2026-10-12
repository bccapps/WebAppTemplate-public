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

  it('stores and loads a session via the injected Redis client when configured', async () => {
    const backing = new Map<string, string>();
    const client = {
      set: jest.fn((key: string, value: string) => {
        backing.set(key, value);
        return Promise.resolve('OK');
      }),
      get: jest.fn((key: string) => Promise.resolve(backing.has(key) ? backing.get(key)! : null)),
    };
    const service = new CryptSessionService(makeRedisService(client));
    const { sessionId } = await service.createSession(clientPublicKeyB64);

    expect(client.set).toHaveBeenCalledTimes(1);
    const session = await service.peekSession(sessionId);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(session).not.toBeNull();
  });

  it('fails open: falls back to in-memory storage when the Redis client throws', async () => {
    const client = {
      set: jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
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
});
