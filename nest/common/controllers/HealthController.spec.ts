/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

const socketDirs: string[] = [];
let pipeCounter = 0;

/**
 * GET `/api/v1/health` over a private unix socket (named pipe on Windows), never over a TCP port.
 * supertest's `request(server)` listens on the wildcard address, then connects to 127.0.0.1:<port>: on macOS a server of
 * another process bound to 127.0.0.1 on that same port (the other specs listen on 127.0.0.1) takes the connection, and
 * the spec reads ITS answer (a 401 "Authentication required", no `revision`). It showed up as an intermittent failure of
 * the whole suite under load, never alone. A socket path belongs to this test only.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getHealth(app: INestApplication): Promise<{ status: number; body: any }> {
  let socketPath: string;
  if (process.platform === 'win32') {
    socketPath = `\\\\.\\pipe\\vx-health-${process.pid}-${pipeCounter++}`;
  } else {
    const dir = mkdtempSync(path.join(tmpdir(), 'vxh-'));
    socketDirs.push(dir);
    socketPath = path.join(dir, 's');
  }
  const server = app.getHttpServer() as http.Server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return new Promise((resolve, reject) => {
    http.get({ socketPath, path: '/api/v1/health', agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

describe('HealthController', () => {
  afterEach(() => {
    jest.useRealTimers();
    for (const dir of socketDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('answers 200 with liveness fields and no contributor', async () => {
    const app = await createApp();
    const res = await getHealth(app);
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
      let res = await getHealth(app);
      expect(res.status).toBe(200);
      expect(res.body.revision).toBe('abc1234-dirty');
      await app.close();

      delete process.env.DEPLOY_REVISION;
      app = await createApp();
      res = await getHealth(app);
      expect(res.status).toBe(200);
      expect(res.body.revision).toBeNull();
      await app.close();
    } finally {
      if (saved === undefined) delete process.env.DEPLOY_REVISION;
      else process.env.DEPLOY_REVISION = saved;
    }
  });

  it('aggregates a single contributor under its key', async () => {
    const app = await createApp({ key: 'infra', check: () => ({ status: 'ok', timestamp: 'now' }) });
    const res = await getHealth(app);
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ infra: { status: 'ok', timestamp: 'now' } });
    await app.close();
  });

  it('stays 200 when a contributor is degraded', async () => {
    const app = await createApp([
      { key: 'a', check: () => ({ status: 'ok' }) },
      { key: 'b', check: async () => ({ status: 'degraded', detail: 'slow' }) },
    ]);
    const res = await getHealth(app);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    await app.close();
  });

  it('answers 503 when a contributor is down or throws', async () => {
    const app = await createApp([
      { key: 'a', check: () => ({ status: 'down' }) },
      { key: 'b', check: () => { throw new Error('boom'); } },
    ]);
    const res = await getHealth(app);
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
