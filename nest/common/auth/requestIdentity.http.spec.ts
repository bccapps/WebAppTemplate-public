/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Body, Controller, Get, INestApplication, Injectable, Post, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Public } from '../decorators/Public';
import { AuthCoreModule } from './AuthCoreModule';
import type { AuthPort } from './AuthPort';
import type { AuthPrincipal } from './AuthPrincipal';

@Injectable()
class FakeUserPort implements AuthPort {
  readonly mode = 'users' as const;
  async resolveToken(token: string): Promise<AuthPrincipal | null> {
    return token === 'good' ? { id: 7, admin: false, kind: 'user' } : null;
  }
}

@Controller('/t')
class IdentityProbeController {
  /** Same shape as vx-private trading `SmcBacktestController.listRuns(@Query('uid'))`. */
  @Get('runs')
  runs(@Query('uid') uid: unknown) {
    return { uid };
  }

  @Public()
  @Get('public')
  publicGet(@Query() query: Record<string, unknown>) {
    return { query };
  }

  @Public()
  @Post('public')
  publicPost(@Body() body: Record<string, unknown>) {
    return { body };
  }
}

/**
 * Real Express 5 + Nest pipeline: `req.query` is a getter re-parsing the URL, so before
 * `requestIdentity.ownQuery` the interceptor's `uid` was lost and `@Query('uid')` returned the
 * client's value (IDOR on any route reading it, e.g. SmcBacktestController.listRuns).
 */
describe('client-supplied identity over HTTP (GlobalAuthInterceptor)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AuthCoreModule.forRoot({ provider: FakeUserPort })],
      controllers: [IdentityProbeController],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("@Query('uid') reads the token's user, never the client's", async () => {
    const res = await request(app.getHttpServer()).get('/t/runs?uid=1').set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uid: 7 });
  });

  it('strips user/uid from the query of a @Public route', async () => {
    const res = await request(app.getHttpServer()).get('/t/public?uid=1&user=x&q=ok');
    expect(res.body).toEqual({ query: { q: 'ok' } });
  });

  it('strips a spoofed {user:{admin:true}} from the body of a @Public route', async () => {
    const res = await request(app.getHttpServer()).post('/t/public').send({ user: { admin: true }, uid: 1, chart: 3 });
    expect(res.body).toEqual({ body: { chart: 3 } });
  });
});
