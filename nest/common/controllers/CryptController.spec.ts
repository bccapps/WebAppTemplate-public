/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { INestApplication, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthCoreModule } from '../auth/AuthCoreModule';
import type { AuthPort } from '../auth/AuthPort';
import type { AuthPrincipal } from '../auth/AuthPrincipal';
import { CryptSessionService } from '../services/CryptSessionService';
import { CryptService } from '../services/CryptService';
import { CryptController } from './CryptController';

@Injectable()
class FakeUserPort implements AuthPort {
  readonly mode = 'users' as const;
  async resolveToken(token: string): Promise<AuthPrincipal | null> {
    if (token === 'admin') return { id: 1, admin: true, kind: 'user' };
    if (token === 'member') return { id: 2, admin: false, kind: 'user' };
    return null;
  }
}

const createSession = jest.fn(async (key: string) => {
  if (key === 'bad') throw new Error('[CryptSessionService] Client public key must be 65 bytes (uncompressed P-256 key).');
  return { sessionId: 's1', serverPublicKey: 'pk', expiresInMs: 600_000 };
});
const decryptFromStorage = jest.fn((payload: string) => `clear:${payload}`);

/** Real controller + real global auth interceptor (AuthCoreModule): `@Public()` per route, admin route behind auth. */
describe('CryptController over HTTP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AuthCoreModule.forRoot({ provider: FakeUserPort })],
      controllers: [CryptController],
      providers: [
        { provide: CryptSessionService, useValue: { createSession, getServerPublicKey: () => 'pk', getSessionTtlMs: () => 600_000 } },
        { provide: CryptService, useValue: { decryptFromStorage } },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('keeps the handshake public', async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/crypt/public-key')).status).toBe(200);
    const res = await request(app.getHttpServer()).post('/api/v1/crypt/session').send({ clientPublicKey: 'good' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ sessionId: 's1', serverPublicKey: 'pk', expiresInMs: 600_000, ttlMs: 600_000 });
  });

  it('answers 400 (not 500) to a malformed client key', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/crypt/session').send({ clientPublicKey: 'bad' });
    expect(res.status).toBe(400);
  });

  it('decrypts for an administrator', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/crypt/admin/decrypt')
      .set('Authorization', 'Bearer admin')
      .send({ payload: 'v1:x' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ value: 'clear:v1:x' });
  });

  it('refuses the decryption without a token, with an unknown token and to a non-admin', async () => {
    decryptFromStorage.mockClear();
    const server = app.getHttpServer();
    expect((await request(server).post('/api/v1/crypt/admin/decrypt').send({ payload: 'v1:x' })).status).toBe(401);
    expect((await request(server).post('/api/v1/crypt/admin/decrypt').set('Authorization', 'Bearer nope').send({ payload: 'v1:x' })).status).toBe(401);
    expect((await request(server).post('/api/v1/crypt/admin/decrypt').set('Authorization', 'Bearer member').send({ payload: 'v1:x' })).status).toBe(401);
    // A client-supplied `user` in the body is scrubbed by the interceptor: no way to pose as an admin.
    expect((await request(server).post('/api/v1/crypt/admin/decrypt').send({ payload: 'v1:x', user: { admin: true } })).status).toBe(401);
    expect(decryptFromStorage).not.toHaveBeenCalled();
  });
});
