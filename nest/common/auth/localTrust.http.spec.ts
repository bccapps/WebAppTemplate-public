/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes } from 'node:crypto';
import { loopbackRequest as request } from '../testing/privateSocketRequest';
import { AuthCoreModule } from './AuthCoreModule';
import { resetLocalUiSessionStoreForTests, shellProof } from './localUiSession';

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

  describe('with the interface session (LOCAL_UI_BOOT_ANCHOR)', () => {
    // A fake boot code built at run time; the anchor the shell would give the back is its SHA-256.
    let code: string;
    let anchor: string;
    beforeEach(() => {
      resetLocalUiSessionStoreForTests();
      code = randomBytes(32).toString('hex');
      anchor = createHash('sha256').update(code, 'utf8').digest('hex');
    });
    afterEach(() => resetLocalUiSessionStoreForTests());

    const exchange = (body: unknown, headers: Record<string, string> = { Host: 'localhost:3000' }) => {
      let r = request(app.getHttpServer()).post('/api/v1/local-ui/session');
      for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
      return r.send(body as object);
    };

    it('a local request without the session (curl, an agent) is no longer the administrator', async () => {
      await boot({ LOCAL_TRUST: 'true', LOCAL_UI_BOOT_ANCHOR: anchor });
      expect((await get({ Host: 'localhost:3000' })).status).toBe(401);
      expect((await get({ Host: '127.0.0.1:3000', Origin: 'http://127.0.0.1:3000' })).status).toBe(401);
      expect((await get({ Host: 'localhost:3000', 'X-Local-Session': randomBytes(32).toString('base64url') })).status).toBe(401);
      expect((await request(app.getHttpServer()).get('/api/v1/local-ui/session').set('Host', 'localhost:3000')).body).toEqual({ required: true, active: false });
    });

    it('the boot code is exchanged once for a session that makes the window the administrator', async () => {
      await boot({ LOCAL_TRUST: 'true', LOCAL_UI_BOOT_ANCHOR: anchor });
      const res = await exchange({ code }, { Host: '127.0.0.1:3000', Origin: 'http://127.0.0.1:3000' });
      expect(res.status).toBe(200);
      const { token, ttlMs, renewAfterMs } = res.body as { token: string; ttlMs: number; renewAfterMs: number };
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(renewAfterMs).toBeLessThan(ttlMs);
      const admin = await get({ Host: '127.0.0.1:3000', Origin: 'http://127.0.0.1:3000', 'X-Local-Session': token });
      expect(admin.status).toBe(200);
      expect(admin.body).toEqual({ admin: true, mode: 'local-trust' });
      expect((await request(app.getHttpServer()).get('/api/v1/local-ui/session').set('Host', 'localhost:3000').set('X-Local-Session', token)).body).toEqual({ required: true, active: true });
      // Replayed: the anchor is spent.
      expect((await exchange({ code })).status).toBe(401);
    });

    it('refuses a wrong code, a malformed body, and an exchange that is not a genuine local request', async () => {
      await boot({ LOCAL_TRUST: 'true', LOCAL_UI_BOOT_ANCHOR: anchor });
      expect((await exchange({ code: randomBytes(32).toString('hex') })).status).toBe(401);
      expect((await exchange({ code: anchor })).status).toBe(401);
      expect((await exchange({})).status).toBe(401);
      expect((await exchange({ code }, { Host: 'evil.example:3000' })).status).toBe(401);
      expect((await exchange({ code }, { Host: 'localhost:3000', Origin: 'http://localhost:8080' })).status).toBe(401);
      expect((await exchange({ code }, { Host: 'localhost:3000', 'X-Forwarded-For': '8.8.8.8' })).status).toBe(401);
      // None of these spent the code: the window still gets its session.
      expect((await exchange({ code })).status).toBe(200);
    });

    it('rotates the token: both pass during the grace period, the new one afterwards', async () => {
      await boot({ LOCAL_TRUST: 'true', LOCAL_UI_BOOT_ANCHOR: anchor });
      const first = (await exchange({ code })).body.token as string;
      const renewed = await request(app.getHttpServer()).post('/api/v1/local-ui/session/renew').set('Host', 'localhost:3000').set('X-Local-Session', first);
      expect(renewed.status).toBe(200);
      const second = renewed.body.token as string;
      expect(second).not.toBe(first);
      expect((await get({ Host: 'localhost:3000', 'X-Local-Session': second })).status).toBe(200);
      expect((await get({ Host: 'localhost:3000', 'X-Local-Session': first })).status).toBe(200);
      expect((await request(app.getHttpServer()).post('/api/v1/local-ui/session/renew').set('Host', 'localhost:3000')).status).toBe(401);
      // The renewed token cannot start a second chain during its grace.
      const again = await request(app.getHttpServer()).post('/api/v1/local-ui/session/renew').set('Host', 'localhost:3000').set('X-Local-Session', first);
      expect(again.status).toBe(409);
    });

    it('answers the launcher\'s challenge with the HMAC of its nonce, only with a key, a loopback socket and a well-formed nonce', async () => {
      const key = randomBytes(32).toString('hex');
      await boot({ LOCAL_TRUST: 'true', LOCAL_UI_BOOT_ANCHOR: anchor, LOCAL_UI_SHELL_KEY: key });
      const nonce = randomBytes(32).toString('hex');
      const res = await request(app.getHttpServer()).get(`/api/v1/local-ui/shell-proof?nonce=${nonce}`).set('Host', '127.0.0.1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ proof: shellProof(key, nonce) });
      expect((await request(app.getHttpServer()).get('/api/v1/local-ui/shell-proof?nonce=zz').set('Host', '127.0.0.1')).status).toBe(401);
      expect((await request(app.getHttpServer()).get(`/api/v1/local-ui/shell-proof?nonce=${nonce}`).set('X-Forwarded-For', '8.8.8.8')).status).toBe(401);
    });

    it('has no challenge without a shell key (404: an app not started by the desktop shell)', async () => {
      await boot({ LOCAL_TRUST: 'true', LOCAL_UI_BOOT_ANCHOR: anchor });
      expect((await request(app.getHttpServer()).get(`/api/v1/local-ui/shell-proof?nonce=${randomBytes(32).toString('hex')}`)).status).toBe(404);
    });

    it('the admin key still works without the session', async () => {
      await boot({ LOCAL_TRUST: 'true', LOCAL_UI_BOOT_ANCHOR: anchor });
      const res = await get({ Host: 'localhost:3000', Authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('anonymous');
    });

    it('is inert without LOCAL_TRUST: no session to hand out', async () => {
      await boot({ LOCAL_TRUST: 'false', LOCAL_UI_BOOT_ANCHOR: anchor });
      expect((await exchange({ code })).status).toBe(401);
      expect((await request(app.getHttpServer()).get('/api/v1/local-ui/session').set('Host', 'localhost:3000')).body).toEqual({ required: false, active: false });
    });
  });
});
