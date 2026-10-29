/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { INestApplication, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import http from 'http';
import type { AddressInfo } from 'net';
import { AuthCoreModule, type AuthPort, type AuthPrincipal } from '../auth';
import { NO_TRANSPORT_CRYPT_KEY } from '../decorators/NoTransportCrypt';
import { RedisService } from '../services/RedisService';
import { EVENT_STREAM_OPTIONS } from './constants';
import { EventStreamController } from './EventStreamController';
import { EventStreamService } from './EventStreamService';

const ADMIN_KEY = 'k'.repeat(40);

/** Stands for vx-private's UserAuthProvider: a user principal; the JWT-like token carries the expiry. */
@Injectable()
class FakeUserAuth implements AuthPort {
  readonly mode = 'users' as const;
  async resolveToken(token: string): Promise<AuthPrincipal | null> {
    const id = Number(token.split('.')[0].replace('user', ''));
    return Number.isFinite(id) ? { id, admin: false, kind: 'user', tenantId: id < 10 ? 'c1' : 'c2' } : null;
  }
}

const userToken = (id: number, expInSeconds: number): string =>
  `user${id}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expInSeconds })).toString('base64url')}.sig`;

class Reader {
  text = '';
  ended = false;
  status = 0;
  headers: http.IncomingHttpHeaders = {};
  constructor(readonly req: http.ClientRequest) {}
  async until(predicate: (text: string) => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!predicate(this.text)) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout; received: ${JSON.stringify(this.text)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  abort(): void {
    this.req.destroy();
  }
}

describe('EventStreamController over HTTP', () => {
  const saved = { ...process.env };
  let app: INestApplication;
  let events: EventStreamService;
  let port: number;
  const readers: Reader[] = [];

  async function boot(env: Record<string, string>, userMode = false, heartbeatMs = 20_000, extra: Record<string, number> = {}): Promise<void> {
    Object.assign(process.env, { HOST: '127.0.0.1', NODE_PORT: '3000', ADMIN_TOKEN: ADMIN_KEY }, env);
    const mod = await Test.createTestingModule({
      imports: [AuthCoreModule.forRoot(userMode ? { provider: FakeUserAuth } : {})],
      controllers: [EventStreamController],
      providers: [
        EventStreamService,
        { provide: RedisService, useValue: { getClient: () => null } },
        { provide: EVENT_STREAM_OPTIONS, useValue: { heartbeatMs, ...extra } },
      ],
    }).compile();
    app = mod.createNestApplication();
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set('trust proxy', true);
    await app.init();
    await app.listen(0, '127.0.0.1');
    events = app.get(EventStreamService);
    port = (app.getHttpServer().address() as AddressInfo).port;
  }

  function open(path: string, headers: Record<string, string> = {}): Promise<Reader> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path, headers: { Host: `localhost:3000`, ...headers } });
      const reader = new Reader(req);
      readers.push(reader);
      req.on('response', (res) => {
        reader.status = res.statusCode ?? 0;
        reader.headers = res.headers;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (reader.text += chunk));
        res.on('end', () => (reader.ended = true));
        res.on('close', () => (reader.ended = true));
        resolve(reader);
      });
      req.on('error', (err) => (reader.ended ? resolve(reader) : reject(err)));
    });
  }

  afterEach(async () => {
    readers.splice(0).forEach((r) => r.abort());
    await app?.close();
    process.env = { ...saved };
  });

  const admin = { Authorization: `Bearer ${ADMIN_KEY}` };

  it('is exempt from transport encryption', () => {
    expect(Reflect.getMetadata(NO_TRANSPORT_CRYPT_KEY, EventStreamController)).toBe(true);
  });

  it('refuses a request without authentication (the global auth interceptor applies to @Sse routes)', async () => {
    await boot({});
    expect((await open('/api/v1/events/stream?topics=x.a')).status).toBe(401);
    expect((await open('/api/v1/events/stream?topics=x.a', { Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('streams two events to an admin-token connection, then frees the connection when the client leaves', async () => {
    await boot({});
    const produce = jest.fn(async () => null);
    events.registerTopicProducer('x.live:*', { intervalMs: 20, authorize: () => true, produce });
    const reader = await open('/api/v1/events/stream?topics=x.runs,x.live:1', admin);
    expect(reader.status).toBe(200);
    expect(reader.headers['content-type']).toContain('text/event-stream');
    expect(reader.headers['x-crypt-session']).toBeUndefined();
    await reader.until((t) => t.includes('event: ready'));
    expect(reader.text).toContain('"topics":["x.runs","x.live:1"]');
    events.publish('x.runs', { type: 'changed', id: 1 }, { admin: true });
    events.publish('x.runs', { type: 'changed', id: 2 }, { admin: true });
    events.publish('x.runs', { type: 'invisible' }, { userId: 99 });
    await reader.until((t) => t.includes('"id":2'));
    expect(reader.text).toMatch(/event: event\n(id: [^\n]+\n)?data: \{"topic":"x.runs","type":"changed","id":1\}/);
    expect(reader.text).not.toContain('invisible');
    await reader.until(() => produce.mock.calls.length >= 2);
    reader.abort();
    await new Promise((r) => setTimeout(r, 100));
    const calls = produce.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(produce.mock.calls.length).toBe(calls);
  });

  it('sends a heartbeat comment', async () => {
    await boot({}, false, 40);
    const reader = await open('/api/v1/events/stream?topics=x.a', admin);
    await reader.until((t) => t.includes(': ping\n\n'));
  });

  it('works in local trust mode without a key', async () => {
    await boot({ LOCAL_TRUST: 'true' });
    const reader = await open('/api/v1/events/stream?topics=x.a');
    expect(reader.status).toBe(200);
    await reader.until((t) => t.includes('event: ready'));
    const refused = await open('/api/v1/events/stream?topics=x.a', { Host: 'evil.example:3000' });
    expect(refused.status).toBe(401);
  });

  it('filters by user and tenant with the user provider, and applies authorizers', async () => {
    await boot({}, true);
    events.registerTopicAuthorizer('x.run:*', (p, m) => String(p.id) === m.key);
    const one = await open('/api/v1/events/stream?topics=x.run:1,x.run:2,x.company', {
      Authorization: `Bearer ${userToken(1, 60)}`,
    });
    const other = await open('/api/v1/events/stream?topics=x.company', { Authorization: `Bearer ${userToken(12, 60)}` });
    await one.until((t) => t.includes('event: ready'));
    expect(one.text).toContain('"denied":["x.run:2"]');
    events.publish('x.run:1', { type: 'a' }, { userId: 1 });
    events.publish('x.company', { type: 'b' }, { tenantId: 'c1' });
    await one.until((t) => t.includes('"type":"b"'));
    expect(one.text).toContain('"type":"a"');
    await other.until((t) => t.includes('event: ready'));
    expect(other.text).not.toContain('"type":"b"');
    const forbidden = await open('/api/v1/events/stream?topics=x.run:1', { Authorization: `Bearer ${userToken(2, 60)}` });
    expect(forbidden.status).toBe(403);
  });

  it('rejects a missing topic list and invalid topics with 400', async () => {
    await boot({});
    expect((await open('/api/v1/events/stream', admin)).status).toBe(400);
    expect((await open('/api/v1/events/stream?topics=nodot', admin)).status).toBe(400);
  });

  it('closes the stream when the token expires', async () => {
    await boot({}, true);
    const reader = await open('/api/v1/events/stream?topics=x.a', { Authorization: `Bearer ${userToken(1, 1)}` });
    await reader.until((t) => t.includes('event: expired'), 4000);
    await reader.until(() => reader.ended, 2000);
  });

  it('cycles a healthy connection after cycleMs, with no `expired` frame (Cloudflare-proxy workaround)', async () => {
    await boot({}, false, 20_000, { cycleMs: 50 });
    const reader = await open('/api/v1/events/stream?topics=x.a', admin);
    await reader.until((t) => t.includes('event: ready'));
    await reader.until(() => reader.ended, 2000);
    expect(reader.text).not.toContain('event: expired');
  });

  it('closes a connection whose client does not read once the pending output exceeds maxPendingBytes', async () => {
    await boot({}, false, 20_000, { maxPendingBytes: 64 * 1024, maxEventBytes: 16 * 1024 });
    const serverSockets: import('net').Socket[] = [];
    app.getHttpServer().on('connection', (sock: import('net').Socket) => serverSockets.push(sock));
    const reader = await new Promise<Reader>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/events/stream?topics=x.a', headers: { Host: 'localhost:3000', ...admin } });
      const r = new Reader(req);
      readers.push(r);
      req.on('response', (res) => {
        r.status = res.statusCode ?? 0;
        res.pause(); // never reads: socket buffers fill up
        resolve(r);
      });
      req.on('error', () => (r.ended = true));
      req.on('error', (e) => (r.status ? undefined : reject(e)));
    });
    expect(reader.status).toBe(200);
    expect(events.connectionCount).toBe(1);
    const payload = 'x'.repeat(15_000);
    for (let i = 0; i < 3000 && events.connectionCount > 0; i++) {
      events.publish('x.a', { type: 'big', data: { payload } }, { public: true });
      if (i % 50 === 0) await new Promise((r) => setImmediate(r));
    }
    expect(events.connectionCount).toBe(0);
    expect(serverSockets.every((sock) => sock.destroyed)).toBe(true);
  });

  it('resumes from Last-Event-ID', async () => {
    await boot({});
    events.publish('x.a', { type: 'old' }, { public: true });
    events.publish('x.a', { type: 'missed' }, { public: true });
    const reader = await open('/api/v1/events/stream?topics=x.a', { ...admin, 'Last-Event-ID': `${events.instanceId}.1` });
    await reader.until((t) => t.includes('"type":"missed"'));
    expect(reader.text).not.toContain('"type":"old"');
    const stale = await open('/api/v1/events/stream?topics=x.a', { ...admin, 'Last-Event-ID': 'elsewhere.7' });
    await stale.until((t) => t.includes('event: resync'));
  });
});
