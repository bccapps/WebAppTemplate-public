/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { INestApplication, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthCoreModule } from '../../common/auth/AuthCoreModule';
import type { AuthPort } from '../../common/auth/AuthPort';
import type { AuthPrincipal } from '../../common/auth/AuthPrincipal';
import { IssueReportService } from '../services/IssueReportService';
import { IssueReportController } from './IssueReportController';

@Injectable()
class FakeUserPort implements AuthPort {
  readonly mode = 'users' as const;
  async resolveToken(token: string): Promise<AuthPrincipal | null> {
    if (token === 'user-7') return { id: 7, admin: false, kind: 'user' };
    if (token === 'admin-key') return { id: 0, admin: true, kind: 'admin-token' };
    return null;
  }
}

/** Real Nest + Express pipeline (global auth interceptor, `@Public`, `RequireUserInterceptor`), service stubbed. */
describe('IssueReportController over HTTP', () => {
  let app: INestApplication;
  const calls: Array<{ principalId: number; body: unknown; userAgent: unknown }> = [];

  beforeAll(async () => {
    const service = {
      isEnabled: () => true,
      create: async (principalId: number, body: unknown, userAgent: unknown) => {
        calls.push({ principalId, body, userAgent });
        return { number: 12 };
      },
      mine: async (principalId: number) => [{ id: 'r1', number: 3, title: `of ${principalId}` }],
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AuthCoreModule.forRoot({ provider: FakeUserPort })],
      controllers: [IssueReportController],
      providers: [{ provide: IssueReportService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the config without authentication and without any hub detail', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/issue-reports/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it('refuses a report without a session, with an unknown token, or from the admin key', async () => {
    const body = { title: 'Broken', description: 'x' };
    expect((await request(app.getHttpServer()).post('/api/v1/issue-reports').send(body)).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/api/v1/issue-reports').set('Authorization', 'Bearer nope').send(body)).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/api/v1/issue-reports').set('Authorization', 'Bearer admin-key').send(body)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('creates a report for the session user, whatever identity the body claims', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/issue-reports')
      .set('Authorization', 'Bearer user-7')
      .set('User-Agent', 'TestAgent/1.0')
      .send({ title: 'Broken', description: 'x', uid: 1, user: { id: 1, admin: true } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ number: 12 });
    expect(calls[0].principalId).toBe(7);
    expect(calls[0].userAgent).toBe('TestAgent/1.0');
  });

  it("lists only the session user's reports", async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/issue-reports/mine')).status).toBe(401);
    const res = await request(app.getHttpServer()).get('/api/v1/issue-reports/mine?uid=1').set('Authorization', 'Bearer user-7');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'r1', number: 3, title: 'of 7' }]);
  });
});
