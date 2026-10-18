/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthController, HEALTH_CONTRIBUTOR_TIMEOUT_MS } from './HealthController';
import { HEALTH_CONTRIBUTORS, HealthContributor } from '../types/ExtensionPoints';

async function createApp(contributors?: HealthContributor | HealthContributor[]) {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: contributors ? [{ provide: HEALTH_CONTRIBUTORS, useValue: contributors }] : [],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('HealthController', () => {
  afterEach(() => jest.useRealTimers());

  it('answers 200 with liveness fields and no contributor', async () => {
    const app = await createApp();
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: {} });
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.version).toBe('string');
    expect(res.body).toHaveProperty('revision');
    expect(new Date(res.body.timestamp).getTime()).not.toBeNaN();
    await app.close();
  });

  it('reports DEPLOY_REVISION, or null when it is not set', async () => {
    const saved = process.env.DEPLOY_REVISION;
    try {
      process.env.DEPLOY_REVISION = 'abc1234-dirty';
      let app = await createApp();
      let res = await request(app.getHttpServer()).get('/api/v1/health');
      expect(res.body.revision).toBe('abc1234-dirty');
      await app.close();

      delete process.env.DEPLOY_REVISION;
      app = await createApp();
      res = await request(app.getHttpServer()).get('/api/v1/health');
      expect(res.body.revision).toBeNull();
      await app.close();
    } finally {
      if (saved === undefined) delete process.env.DEPLOY_REVISION;
      else process.env.DEPLOY_REVISION = saved;
    }
  });

  it('aggregates a single contributor under its key', async () => {
    const app = await createApp({ key: 'infra', check: () => ({ status: 'ok', timestamp: 'now' }) });
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ infra: { status: 'ok', timestamp: 'now' } });
    await app.close();
  });

  it('stays 200 when a contributor is degraded', async () => {
    const app = await createApp([
      { key: 'a', check: () => ({ status: 'ok' }) },
      { key: 'b', check: async () => ({ status: 'degraded', detail: 'slow' }) },
    ]);
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    await app.close();
  });

  it('answers 503 when a contributor is down or throws', async () => {
    const app = await createApp([
      { key: 'a', check: () => ({ status: 'down' }) },
      { key: 'b', check: () => { throw new Error('boom'); } },
    ]);
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('down');
    expect(res.body.checks.b).toEqual({ status: 'down', error: 'boom' });
    await app.close();
  });

  it('counts a contributor that never answers as down', async () => {
    const app = await createApp({ key: 'slow', check: () => new Promise(() => undefined) });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const controller = app.get(HealthController);
    const res = { status: jest.fn() };
    const pending = controller.check(res as never);
    await jest.advanceTimersByTimeAsync(HEALTH_CONTRIBUTOR_TIMEOUT_MS);
    const body = await pending;
    expect(body.checks.slow).toEqual({ status: 'down', error: 'timeout' });
    expect(res.status).toHaveBeenCalledWith(503);
    jest.useRealTimers();
    await app.close();
  });
});
