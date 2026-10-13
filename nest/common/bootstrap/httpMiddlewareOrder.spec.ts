/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it } from '@jest/globals';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { lazyCompression } from './compressionMiddleware';

@Controller()
class BigController {
  @Get('/api/v1/big')
  big() {
    return { data: 'x'.repeat(5000) };
  }
}

@Module({ controllers: [BigController] })
class BigModule {}

async function createApp(setup: (app: INestApplication, afterInit: boolean) => void, afterInit: boolean) {
  const moduleRef = await Test.createTestingModule({ imports: [BigModule] }).compile();
  const app = moduleRef.createNestApplication();
  if (!afterInit) setup(app, false);
  await app.init();
  if (afterInit) setup(app, true);
  return app;
}

const swagger = (app: INestApplication) =>
  SwaggerModule.setup('api', app, SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('T').build()));

describe('Swagger registration order', () => {
  it('is unreachable when set up after app.init() (why main.ts must call it before)', async () => {
    const app = await createApp((a) => swagger(a), true);
    try {
      expect((await request(app.getHttpServer()).get('/api').redirects(1)).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('serves the Swagger UI and the JSON document when set up before app.init()', async () => {
    const app = await createApp((a) => swagger(a), false);
    try {
      const ui = await request(app.getHttpServer()).get('/api').redirects(1);
      expect(ui.status).toBe(200);
      expect(ui.text).toContain('swagger');
      const json = await request(app.getHttpServer()).get('/api-json');
      expect(json.status).toBe(200);
      expect(json.body.paths).toHaveProperty('/api/v1/big');
      expect((await request(app.getHttpServer()).get('/api/v1/big')).status).toBe(200);
      expect((await request(app.getHttpServer()).get('/api/v1/nope')).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('compression registration order', () => {
  const gzip = (app: INestApplication) =>
    request(app.getHttpServer()).get('/api/v1/big').set('Accept-Encoding', 'gzip');

  it('is not applied when registered after app.init()', async () => {
    const app = await createApp((a) => a.use(lazyCompression(() => 1024)), true);
    try {
      expect((await gzip(app)).headers['content-encoding']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('compresses a large JSON response when registered before app.init()', async () => {
    const app = await createApp((a) => a.use(lazyCompression(() => 1024)), false);
    try {
      const res = await gzip(app);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.body.data).toHaveLength(5000);
    } finally {
      await app.close();
    }
  });

  it('reads the threshold lazily (after init) and honours it', async () => {
    let threshold: number | undefined;
    const app = await createApp((a) => a.use(lazyCompression(() => threshold)), false);
    try {
      threshold = 100000; // only known once init has run: above the 5 kB body, so no compression
      expect((await gzip(app)).headers['content-encoding']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('falls back to the default threshold when the lookup fails', async () => {
    const app = await createApp(
      (a) =>
        a.use(
          lazyCompression(() => {
            throw new Error('config not ready');
          }),
        ),
      false,
    );
    try {
      expect((await gzip(app)).headers['content-encoding']).toBe('gzip');
    } finally {
      await app.close();
    }
  });
});
