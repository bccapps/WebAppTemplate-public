/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { isApiPath, resolveFrontDir, serveFrontend } from './serveFrontend';

@Controller()
class ApiController {
  @Get('/api/v1/health')
  health() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [ApiController] })
class ApiModule {}

describe('serveFrontend helpers', () => {
  it('resolves SERVE_FRONT_DIR, undefined when unset or blank', () => {
    expect(resolveFrontDir({})).toBeUndefined();
    expect(resolveFrontDir({ SERVE_FRONT_DIR: '  ' })).toBeUndefined();
    expect(resolveFrontDir({ SERVE_FRONT_DIR: '/srv/front' })).toBe('/srv/front');
  });

  it('treats /api and /api/* as API paths only', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/v1/health')).toBe(true);
    expect(isApiPath('/apiary')).toBe(false);
    expect(isApiPath('/app/x')).toBe(false);
  });
});

describe('serveFrontend', () => {
  let dir: string;
  let app: INestApplication;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'serve-front-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
    writeFileSync(join(dir, 'assets', 'a.js'), 'console.log(1)');
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    serveFrontend(app, dir);
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['/', '/app/x', '/index.html'])('serves the index without cache on %s', async (path) => {
    const res = await request(app.getHttpServer()).get(path).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>spa</title>');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('does not intercept the API', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').set('Accept', 'text/html');
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('does not answer /api and unknown /api/* with the index', async () => {
    for (const path of ['/api', '/api/v1/nope']) {
      const res = await request(app.getHttpServer()).get(path).set('Accept', 'text/html');
      expect(res.text).not.toContain('<title>spa</title>');
    }
  });

  it('serves /assets/* as immutable', async () => {
    const res = await request(app.getHttpServer()).get('/assets/a.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('answers 404 (not the index) for a missing asset', async () => {
    const res = await request(app.getHttpServer()).get('/assets/missing.js').set('Accept', 'text/html');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<title>spa</title>');
  });

  it('falls back only for GET requests that accept HTML', async () => {
    const post = await request(app.getHttpServer()).post('/app/x');
    expect(post.status).toBe(404);
    const json = await request(app.getHttpServer()).get('/app/x').set('Accept', 'application/json');
    expect(json.status).toBe(404);
  });

  it('refuses a directory without index.html', () => {
    const empty = mkdtempSync(join(tmpdir(), 'serve-front-empty-'));
    try {
      expect(() => serveFrontend(app, empty)).toThrow(/index\.html not found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
