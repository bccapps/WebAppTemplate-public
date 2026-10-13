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
});
