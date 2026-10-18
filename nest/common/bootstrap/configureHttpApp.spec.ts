/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it } from '@jest/globals';
import { Body, Controller, Get, Module, Post, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import request from 'supertest';
import {
  assertSafeOrigins,
  configureHttpApp,
  HttpAppOptions,
  isPublicCorsPath,
  parseTrustProxy,
  resolveHttpAppOptions,
  resolveListenHost,
} from './configureHttpApp';

class EchoDto {
  @IsString()
  name!: string;
}

@Controller()
class EchoController {
  @Post('/hook/webhook')
  hook(@Req() req: { rawBody?: Buffer }, @Body() body: unknown) {
    return { raw: req.rawBody?.toString('utf8') ?? null, body };
  }

  @Post('/plain')
  plain(@Req() req: { rawBody?: Buffer }, @Body() body: EchoDto) {
    return { raw: req.rawBody?.toString('utf8') ?? null, body };
  }

  @Get('/pub/img')
  pub() {
    return { ok: true };
  }

  @Get('/ip')
  ip(@Req() req: { ip: string }) {
    return { ip: req.ip };
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

async function createApp(options: HttpAppOptions) {
  const moduleRef = await Test.createTestingModule({ imports: [EchoModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureHttpApp(app, options);
  await app.init();
  return app;
}

describe('resolveHttpAppOptions', () => {
  it('falls back to the front dev origin and the /webhook raw-body path', () => {
    const r = resolveHttpAppOptions({}, { FRONT_PORT: '5173' });
    expect(r.allowedOrigins).toEqual(['http://localhost:5173']);
    expect(r.rawBodyPaths).toEqual(['/webhook']);
    expect(r.production).toBe(false);
    expect(r.trustProxy).toBe(false);
  });

  it('reads CLIENT_ORIGINS and RAW_BODY_PATHS, trimming blanks', () => {
    const r = resolveHttpAppOptions({}, { CLIENT_ORIGINS: ' https://a.io , ,https://b.io', RAW_BODY_PATHS: '/stripe, /coinbase' });
    expect(r.allowedOrigins).toEqual(['https://a.io', 'https://b.io']);
    expect(r.rawBodyPaths).toEqual(['/stripe', '/coinbase']);
  });

  it('lets explicit options win over the environment', () => {
    const r = resolveHttpAppOptions({ clientOrigins: 'https://x.io', rawBodyPaths: ['/w'] }, { CLIENT_ORIGINS: 'https://a.io' });
    expect(r.allowedOrigins).toEqual(['https://x.io']);
    expect(r.rawBodyPaths).toEqual(['/w']);
  });

  it('refuses the wildcard origin in production', () => {
    expect(() => resolveHttpAppOptions({}, { NODE_ENV: 'production', CLIENT_ORIGINS: '*' })).toThrow(/CORS wildcard/);
    expect(() => assertSafeOrigins(['https://a.io', '*'], true)).toThrow(/not allowed in production/);
  });

  it('accepts the wildcard origin outside production', () => {
    expect(resolveHttpAppOptions({}, { CLIENT_ORIGINS: '*' }).allowedOrigins).toEqual(['*']);
  });

  it('trusts one proxy hop in production by default', () => {
    expect(resolveHttpAppOptions({}, { NODE_ENV: 'production', CLIENT_ORIGINS: 'https://a.io' }).trustProxy).toBe(1);
  });
});

describe('resolveHttpAppOptions (headers and validation)', () => {
  it('defaults to the built-in headers and the whitelist + transform pipe', () => {
    const r = resolveHttpAppOptions({}, { FRONT_PORT: '1' });
    expect(r.allowedHeaders).toEqual(['Content-Type', 'Authorization', 'x-crypt-session', 'x-crypt-accept-encoding']);
    expect(r.validation).toEqual({ whitelist: true, transform: true });
  });

  it('appends extra headers without duplicates and honours validation: false', () => {
    const r = resolveHttpAppOptions({ extraCorsHeaders: ['x-company-id', ' Authorization ', ''], validation: false }, { FRONT_PORT: '1' });
    expect(r.allowedHeaders).toEqual(['Content-Type', 'Authorization', 'x-crypt-session', 'x-crypt-accept-encoding', 'x-company-id']);
    expect(r.validation).toBe(false);
  });
});

describe('parseTrustProxy', () => {
  it.each([
    [undefined, false, false],
    [undefined, true, 1],
    ['true', false, true],
    ['false', true, false],
    ['2', false, 2],
    ['loopback', false, 'loopback'],
  ])('parses %p (production=%p) as %p', (value, production, expected) => {
    expect(parseTrustProxy(value, production)).toBe(expected);
  });
});

describe('resolveListenHost', () => {
  it('defaults to 0.0.0.0 and honours HOST', () => {
    expect(resolveListenHost({})).toBe('0.0.0.0');
    expect(resolveListenHost({ HOST: ' 127.0.0.1 ' })).toBe('127.0.0.1');
  });
});

describe('configureHttpApp', () => {
  it('captures rawBody on raw-body paths only', async () => {
    const app = await createApp({ clientOrigins: 'https://a.io', rawBodyPaths: ['/webhook'] });
    const payload = '{"id":  1}';
    const hook = await request(app.getHttpServer()).post('/hook/webhook').set('Content-Type', 'application/json').send(payload);
    expect(hook.body).toEqual({ raw: payload, body: { id: 1 } });
    const plain = await request(app.getHttpServer()).post('/plain').send({ name: 'x' });
    expect(plain.body.raw).toBeNull();
    await app.close();
  });

  it('applies the validation pipe (whitelist strips unknown properties, invalid body is a 400)', async () => {
    const app = await createApp({ clientOrigins: 'https://a.io' });
    const ok = await request(app.getHttpServer()).post('/plain').send({ name: 'x', extra: 1 });
    expect(ok.body.body).toEqual({ name: 'x' });
    const bad = await request(app.getHttpServer()).post('/plain').send({ name: 5 });
    expect(bad.status).toBe(400);
    await app.close();
  });

  it('registers no validation pipe with validation: false (unknown properties kept, invalid body accepted)', async () => {
    const app = await createApp({ clientOrigins: 'https://a.io', validation: false });
    const ok = await request(app.getHttpServer()).post('/plain').send({ name: 'x', extra: 1 });
    expect(ok.body.body).toEqual({ name: 'x', extra: 1 });
    const bad = await request(app.getHttpServer()).post('/plain').send({ name: 5 });
    expect(bad.status).toBe(201);
    await app.close();
  });

  it('validateOnly: rejects an invalid body but hands the handler the request body untouched', async () => {
    const app = await createApp({ clientOrigins: 'https://a.io', validation: { validateOnly: true } });
    const ok = await request(app.getHttpServer()).post('/plain').send({ name: 'x', extra: 1 });
    expect(ok.body.body).toEqual({ name: 'x', extra: 1 });
    const bad = await request(app.getHttpServer()).post('/plain').send({ name: 5 });
    expect(bad.status).toBe(400);
    await app.close();
  });

  it('merges partial validation options over the defaults', async () => {
    const app = await createApp({ clientOrigins: 'https://a.io', validation: { forbidNonWhitelisted: true } });
    const res = await request(app.getHttpServer()).post('/plain').send({ name: 'x', extra: 1 });
    expect(res.status).toBe(400);
    await app.close();
  });

  it('allows extra CORS request headers in the preflight, besides the built-in ones', async () => {
    const app = await createApp({ clientOrigins: 'https://a.io', extraCorsHeaders: ['x-company-id'] });
    const res = await request(app.getHttpServer())
      .options('/plain')
      .set('Origin', 'https://a.io')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-company-id, authorization');
    const allowed = String(res.headers['access-control-allow-headers']).toLowerCase();
    expect(allowed).toContain('x-company-id');
    expect(allowed).toContain('authorization');
    await app.close();
  });

  it('rejects a body over the JSON limit', async () => {
    const app = await createApp({ clientOrigins: 'https://a.io', jsonLimit: '1kb' });
    const res = await request(app.getHttpServer()).post('/plain').send({ name: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
    await app.close();
  });

  it('allows listed origins with credentials and blocks others', async () => {
    const app = await createApp({ clientOrigins: 'https://a.io' });
    const allowed = await request(app.getHttpServer()).get('/ip').set('Origin', 'https://a.io');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://a.io');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const blocked = await request(app.getHttpServer()).get('/ip').set('Origin', 'https://evil.io');
    expect(blocked.status).toBe(403);
    await app.close();
  });

  it('reflects any origin without credentials for the wildcard outside production', async () => {
    const app = await createApp({ clientOrigins: '*', production: false });
    const res = await request(app.getHttpServer()).get('/ip').set('Origin', 'https://any.io');
    expect(res.headers['access-control-allow-origin']).toBe('https://any.io');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    await app.close();
  });

  it('refuses to configure the app with a wildcard in production', async () => {
    await expect(createApp({ clientOrigins: '*', production: true })).rejects.toThrow(/CORS wildcard/);
  });

  it('sets security headers and honours trust proxy', async () => {
    const app = await createApp({ clientOrigins: 'https://a.io', trustProxy: 1 });
    const res = await request(app.getHttpServer()).get('/ip').set('X-Forwarded-For', '203.0.113.9');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.body.ip).toBe('203.0.113.9');
    await app.close();
  });

  describe('publicCorsPaths', () => {
    const options: HttpAppOptions = { clientOrigins: 'https://a.io', publicCorsPaths: ['/pub/'] };

    it('accepts any origin, the opaque "null" one included, without credentials on a public prefix', async () => {
      const app = await createApp(options);
      const opaque = await request(app.getHttpServer()).get('/pub/img').set('Origin', 'null');
      expect(opaque.status).toBe(200);
      expect(opaque.headers['access-control-allow-origin']).toBe('null');
      expect(opaque.headers['access-control-allow-credentials']).toBeUndefined();
      const foreign = await request(app.getHttpServer()).get('/pub/img').set('Origin', 'https://evil.io');
      expect(foreign.status).toBe(200);
      expect(foreign.headers['access-control-allow-origin']).toBe('https://evil.io');
      await app.close();
    });

    it('sets Cross-Origin-Resource-Policy: cross-origin on the public prefix only', async () => {
      const app = await createApp(options);
      const pub = await request(app.getHttpServer()).get('/pub/img');
      expect(pub.headers['cross-origin-resource-policy']).toBe('cross-origin');
      const other = await request(app.getHttpServer()).get('/ip');
      expect(other.headers['cross-origin-resource-policy']).toBe('same-origin');
      await app.close();
    });

    it('keeps the allow-list on every other route', async () => {
      const app = await createApp(options);
      const blocked = await request(app.getHttpServer()).get('/ip').set('Origin', 'null');
      expect(blocked.status).toBe(403);
      const evil = await request(app.getHttpServer()).get('/ip').set('Origin', 'https://evil.io');
      expect(evil.status).toBe(403);
      const allowed = await request(app.getHttpServer()).get('/ip').set('Origin', 'https://a.io');
      expect(allowed.headers['access-control-allow-origin']).toBe('https://a.io');
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      await app.close();
    });

    it('answers the preflight of a public path for any origin', async () => {
      const app = await createApp(options);
      const res = await request(app.getHttpServer())
        .options('/pub/img')
        .set('Origin', 'null')
        .set('Access-Control-Request-Method', 'GET');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('null');
      await app.close();
    });

    it('does nothing by default and resolves blank prefixes away', () => {
      expect(resolveHttpAppOptions({}, { FRONT_PORT: '1' }).publicCorsPaths).toEqual([]);
      expect(resolveHttpAppOptions({ publicCorsPaths: [' /a/ ', ''] }, { FRONT_PORT: '1' }).publicCorsPaths).toEqual(['/a/']);
    });

    it('matches by prefix', () => {
      expect(isPublicCorsPath('/pub/x', ['/pub/'])).toBe(true);
      expect(isPublicCorsPath('/public', ['/pub/'])).toBe(false);
    });
  });

  describe('corsOriginPolicy', () => {
    const EXT = 'chrome-extension://abc';
    const calls: Array<[string, string, string]> = [];
    const policy = (origin: string, req: { path: string; method: string }) => {
      calls.push([origin, req.path, req.method]);
      if (origin === EXT) return req.path === '/pub/img' || req.path === '/plain' ? true : undefined;
      if (origin === 'https://nocookie.io') return { credentials: false };
      if (origin === 'https://no.io') return false;
      return undefined;
    };
    const options: HttpAppOptions = { clientOrigins: 'https://a.io', corsOriginPolicy: policy };

    it('allows a foreign origin on a route the policy accepts, with credentials', async () => {
      const app = await createApp(options);
      const res = await request(app.getHttpServer()).get('/pub/img').set('Origin', EXT);
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(EXT);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      await app.close();
    });

    it('refuses the same origin on another route (policy undefined)', async () => {
      const app = await createApp(options);
      const res = await request(app.getHttpServer()).get('/ip').set('Origin', EXT);
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      await app.close();
    });

    it('refuses on false and honours credentials: false', async () => {
      const app = await createApp(options);
      expect((await request(app.getHttpServer()).get('/ip').set('Origin', 'https://no.io')).status).toBe(403);
      const res = await request(app.getHttpServer()).get('/ip').set('Origin', 'https://nocookie.io');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://nocookie.io');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      await app.close();
    });

    it('passes the path and the requested method on a preflight', async () => {
      const app = await createApp(options);
      calls.length = 0;
      const res = await request(app.getHttpServer())
        .options('/plain')
        .set('Origin', EXT)
        .set('Access-Control-Request-Method', 'post')
        .set('Access-Control-Request-Headers', 'content-type');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(EXT);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(calls).toEqual([[EXT, '/plain', 'POST']]);
      const denied = await request(app.getHttpServer())
        .options('/ip')
        .set('Origin', EXT)
        .set('Access-Control-Request-Method', 'GET');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
      await app.close();
    });

    it('does not consult the policy for CLIENT_ORIGINS nor without Origin, and keeps their behaviour', async () => {
      const app = await createApp(options);
      calls.length = 0;
      const allowed = await request(app.getHttpServer()).get('/ip').set('Origin', 'https://a.io');
      expect(allowed.headers['access-control-allow-origin']).toBe('https://a.io');
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      expect((await request(app.getHttpServer()).get('/ip')).status).toBe(200);
      expect(calls).toEqual([]);
      await app.close();
    });

    it('keeps extraCorsHeaders, publicCorsPaths and the query string handling', async () => {
      const app = await createApp({ ...options, extraCorsHeaders: ['x-company-id'], publicCorsPaths: ['/pub/'] });
      const pre = await request(app.getHttpServer())
        .options('/plain?x=1')
        .set('Origin', EXT)
        .set('Access-Control-Request-Method', 'POST');
      expect(pre.headers['access-control-allow-headers']).toContain('x-company-id');
      const pub = await request(app.getHttpServer()).get('/pub/img').set('Origin', 'https://evil.io');
      expect(pub.headers['access-control-allow-origin']).toBe('https://evil.io');
      expect(pub.headers['access-control-allow-credentials']).toBeUndefined();
      await app.close();
    });
  });
});
