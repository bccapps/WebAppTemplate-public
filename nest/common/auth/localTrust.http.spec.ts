/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterAll, afterEach, describe, expect, it } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthCoreModule } from './AuthCoreModule';

/**
 * End-to-end through a real HTTP socket (supertest connects from loopback), with `trust proxy` on as configureHttpApp
 * does in production. Proves that a forged X-Forwarded-For / Host / Origin cannot elevate a request.
 */
describe('local trust over HTTP', () => {
  const saved = { ...process.env };
  let app: INestApplication;
  const TOKEN = 'k'.repeat(40);

  async function boot(env: Record<string, string>): Promise<void> {
    Object.assign(process.env, { HOST: '127.0.0.1', NODE_PORT: '3000', ADMIN_TOKEN: TOKEN }, env);
    const mod = await Test.createTestingModule({ imports: [AuthCoreModule.forRoot()] }).compile();
    app = mod.createNestApplication();
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set('trust proxy', true);
    await app.init();
  }
  afterEach(async () => {
    await app?.close();
    process.env = { ...saved };
  });
  afterAll(() => {
    process.env = { ...saved };
  });

  const get = (headers: Record<string, string>) => {
    let r = request(app.getHttpServer()).get('/api/v1/admin-session');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r;
  };

  it('grants local-trust to a genuine local request', async () => {
    await boot({ LOCAL_TRUST: 'true' });
    const res = await get({ Host: 'localhost:3000' });
    expect((await get({ Host: 'localhost:3000', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await get({ Host: 'localhost:3000', 'Sec-Fetch-Site': 'none' })).status).toBe(200);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ admin: true, mode: 'local-trust' });
    // The app's own origin (same host:port as Host) is fine; another loopback port is not, unless allow-listed.
    expect((await get({ Host: '127.0.0.1:3000', Origin: 'http://127.0.0.1:3000' })).status).toBe(200);
    expect((await get({ Host: '127.0.0.1:3000', Origin: 'http://localhost:5173' })).status).toBe(401);
  });

  it('accepts a loopback Origin listed in CLIENT_ORIGINS (the dev front on its own port)', async () => {
    await boot({ LOCAL_TRUST: 'true', CLIENT_ORIGINS: 'http://localhost:5173' });
    expect((await get({ Host: '127.0.0.1:3000', Origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await get({ Host: '127.0.0.1:3000', Origin: 'http://localhost:5174' })).status).toBe(401);
  });

  it.each([
    ['foreign Host (DNS rebinding)', { Host: 'evil.example:3000' }],
    ['foreign Origin (cross-site page)', { Host: 'localhost:3000', Origin: 'https://evil.example' }],
    ['opaque Origin', { Host: 'localhost:3000', Origin: 'null' }],
    ['another loopback port (an agent dev server)', { Host: 'localhost:3000', Origin: 'http://localhost:8080' }],
    ['cross-site fetch without Origin (simple GET)', { Host: 'localhost:3000', 'Sec-Fetch-Site': 'cross-site' }],
    ['same-site fetch without Origin', { Host: 'localhost:3000', 'Sec-Fetch-Site': 'same-site' }],
    ['forged X-Forwarded-For', { Host: 'localhost:3000', 'X-Forwarded-For': '8.8.8.8' }],
    ['wrong port in Host', { Host: 'localhost:4000' }],
  ])('stays anonymous (401) with %s', async (_name, headers) => {
    await boot({ LOCAL_TRUST: 'true' });
    expect((await get(headers)).status).toBe(401);
  });

  it('accepts the front dev-server Host only with APP_ENV=dev', async () => {
    await boot({ LOCAL_TRUST: 'true', FRONT_PORT: '5173', APP_ENV: 'dev' });
    expect((await get({ Host: 'localhost:5173', Origin: 'http://localhost:5173' })).body.mode).toBe('local-trust');
    expect((await get({ Host: 'localhost:3000', Origin: 'http://localhost:5173' })).body.mode).toBe('local-trust');
    expect((await get({ Host: 'localhost:5173', 'X-Forwarded-For': '8.8.8.8' })).status).toBe(401);
    expect((await get({ Host: 'localhost:5174' })).status).toBe(401);
  });

  it('refuses the front dev-server Host outside APP_ENV=dev', async () => {
    await boot({ LOCAL_TRUST: 'true', FRONT_PORT: '5173', APP_ENV: 'prod' });
    expect((await get({ Host: 'localhost:5173' })).status).toBe(401);
  });

  it('still accepts the admin key from a refused request', async () => {
    await boot({ LOCAL_TRUST: 'true' });
    const res = await get({ Host: 'evil.example:3000', Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('anonymous');
  });

  it('has no effect without LOCAL_TRUST', async () => {
    await boot({ LOCAL_TRUST: 'false' });
    expect((await get({ Host: 'localhost:3000' })).status).toBe(401);
  });

  it('refuses to start with LOCAL_TRUST=true and HOST=0.0.0.0', async () => {
    Object.assign(process.env, { LOCAL_TRUST: 'true', HOST: '0.0.0.0' });
    await expect(Test.createTestingModule({ imports: [AuthCoreModule.forRoot()] }).compile()).rejects.toThrow(/LOCAL_TRUST=true requires HOST/);
  });
});
