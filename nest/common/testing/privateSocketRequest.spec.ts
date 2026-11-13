/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync } from 'node:fs';
import http, { type RequestListener, type Server } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { loopbackRequest, privateSocketRequest } from './privateSocketRequest';

const echo: RequestListener = (req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/missing') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ statusCode: 404, message: 'nope' }));
    } else if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/echo?from=redirect' }).end();
    } else if (url.pathname === '/away') {
      res.writeHead(302, { Location: 'https://elsewhere.example/x' }).end();
    } else if (url.pathname === '/gzip') {
      const body = zlib.gzipSync(JSON.stringify({ big: 'x'.repeat(3000) }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }).end(body);
    } else if (url.pathname === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Custom': 'yes' }).end('<title>spa é</title>');
    } else if (url.pathname === '/empty') {
      res.writeHead(204).end();
    } else if (url.pathname === '/limit') {
      // Answers before reading the body, then drops the connection, like a body-size limit does.
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify({ message: 'too large' }));
      req.destroy();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks).toString('utf8'), peer: req.socket.remoteAddress ?? null }),
      );
    }
  });
};

const servers: Server[] = [];
function serverOf(listener: RequestListener = echo): Server {
  const server = http.createServer(listener);
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const server of servers.splice(0)) if (server.listening) server.close();
});

describe.each([
  ['privateSocketRequest', privateSocketRequest],
  ['loopbackRequest', loopbackRequest],
])('%s', (_name, request) => {
  it('sends the method, the path with its query, the headers and a JSON body, and reads headers, JSON body and text back', async () => {
    const res = await request(serverOf())
      .post('/echo?a=1')
      .set('X-One', '1')
      .set({ 'X-Two': 2 })
      .query({ b: 'two words' })
      .send({ name: 'x' })
      .send({ more: true });
    expect(res.status).toBe(200);
    expect(res.statusText).toBe('OK');
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.body.method).toBe('POST');
    expect(res.body.url).toBe('/echo?a=1&b=two+words');
    expect(res.body.headers).toMatchObject({ 'x-one': '1', 'x-two': '2', 'content-type': 'application/json', 'content-length': '24' });
    expect(JSON.parse(res.body.raw)).toEqual({ name: 'x', more: true });
    expect(JSON.parse(res.text)).toEqual(res.body);
  });

  it('keeps a string body as it is, with the Content-Type the spec sets (or the form default)', async () => {
    const server = serverOf();
    const json = await request(server).post('/echo').set('Content-Type', 'application/json').send('{"name": }');
    expect(json.body.raw).toBe('{"name": }');
    expect(json.body.headers['content-type']).toBe('application/json');
    const form = await request(server).put('/echo').send('a=1');
    expect(form.body.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const typed = await request(server).patch('/echo').type('text').send('plain');
    expect(typed.body.headers['content-type']).toBe('text/plain');
    expect(typed.body.raw).toBe('plain');
  });

  it('serves the other methods and exposes an HTML answer as text (body stays empty)', async () => {
    const server = serverOf();
    const html = await request(server).get('/html');
    expect(html.text).toBe('<title>spa é</title>');
    expect(html.body).toEqual({});
    expect(html.headers['x-custom']).toBe('yes');
    expect((await request(server).delete('/echo')).body.method).toBe('DELETE');
    expect((await request(server).options('/echo')).body.method).toBe('OPTIONS');
    const head = await request(server).head('/html');
    expect([head.status, head.text]).toEqual([200, '']);
    const empty = await request(server).get('/empty');
    expect([empty.status, empty.text, empty.body]).toEqual([204, '', {}]);
  });

  it('answers a 404 as a response, with its JSON body', async () => {
    const res = await request(serverOf()).get('/missing');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ statusCode: 404, message: 'nope' });
  });

  it('asks for gzip like superagent does and decodes the answer', async () => {
    const res = await request(serverOf()).get('/gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.big).toHaveLength(3000);
    expect(res.text.length).toBeGreaterThan(3000);
    expect((await request(serverOf()).get('/echo').set('Accept-Encoding', 'identity')).body.headers['accept-encoding']).toBe('identity');
  });

  it('follows no redirect unless asked, then only to a path of the same server', async () => {
    const server = serverOf();
    const first = await request(server).get('/redirect');
    expect([first.status, first.headers.location]).toEqual([302, '/echo?from=redirect']);
    const followed = await request(server).get('/redirect').redirects(1);
    expect([followed.status, followed.body.url]).toEqual([200, '/echo?from=redirect']);
    const away = await request(server).get('/away').redirects(3);
    expect([away.status, away.headers.location]).toEqual([302, 'https://elsewhere.example/x']);
  });

  it('turns .expect() into a rejection on a status mismatch and checks a body', async () => {
    const server = serverOf();
    await request(server).get('/missing').expect(404);
    await request(server).get('/missing').expect([400, 404]);
    await request(server).get('/missing').expect(404, { statusCode: 404, message: 'nope' });
    await expect(request(server).get('/missing').expect(200)).rejects.toThrow('expected 200 "OK", got 404 "Not Found"');
    await expect(request(server).get('/missing').expect(404, { statusCode: 404 })).rejects.toThrow();
    expect(() => request(server).get('/missing').expect('Content-Type' as never)).toThrow(TypeError);
  });

  it('reads an early answer (413) even when the server drops the connection while the body is being written', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(4_000_000) });
    const res = await request(serverOf()).post('/limit').set('Content-Type', 'application/json').send(big);
    expect([res.status, res.body]).toEqual([413, { message: 'too large' }]);
  });

  it('rejects when nothing answers (the connection is dropped) instead of hanging', async () => {
    const server = serverOf((req) => req.socket.destroy());
    await expect(request(server).get('/x')).rejects.toThrow();
    expect(server.listening).toBe(false);
  });

  it('shares one listening server between concurrent requests, closes it after the last one, and can start again', async () => {
    const server = serverOf();
    const seen = new Set<string>();
    server.on('listening', () => seen.add(JSON.stringify(server.address())));
    const answers = await Promise.all(Array.from({ length: 12 }, (_, index) => request(server).get(`/echo?i=${index}`)));
    expect(answers.map((res) => res.body.url)).toEqual(answers.map((_res, index) => `/echo?i=${index}`));
    expect(seen.size).toBe(1);
    expect(server.listening).toBe(false);
    expect((await request(server).get('/echo')).status).toBe(200);
    expect(seen.size).toBe(2);
    expect(server.listening).toBe(false);
  });

  it('accepts a request listener (an Express app) as well as a server, and works through a Nest app that is closed afterwards', async () => {
    expect((await request(echo).get('/echo')).status).toBe(200);

    @Controller('ping')
    class PingController {
      @Get()
      ping() {
        return { ok: true };
      }
    }
    @Module({ controllers: [PingController] })
    class PingModule {}
    const app = (await Test.createTestingModule({ imports: [PingModule] }).compile()).createNestApplication();
    await app.init();
    const res = await request(app.getHttpServer()).get('/ping').expect(200, { ok: true });
    expect(res.status).toBe(200);
    await expect(app.close()).resolves.toBeUndefined();
  });

  it('does not close a server it did not start, and refuses one bound to a wildcard address', async () => {
    const mine = serverOf();
    await new Promise<void>((resolve) => mine.listen(0, '127.0.0.1', resolve));
    expect((await request(mine).get('/echo')).status).toBe(200);
    expect(mine.listening).toBe(true);

    const wild = serverOf();
    await new Promise<void>((resolve) => wild.listen(0, resolve));
    await expect(request(wild).get('/echo')).rejects.toThrow('wildcard address');
    expect(wild.listening).toBe(true);
  });
});

describe('privateSocketRequest transport', () => {
  it('listens on a private socket path, not on a TCP port, and removes its directory when done', async () => {
    const server = serverOf((req, res) => {
      const address = server.address();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ address, peer: req.socket.remoteAddress ?? null }));
    });
    const res = await privateSocketRequest(server).get('/where');
    const address = res.body.address as string;
    expect(typeof address).toBe('string');
    expect(res.body.peer).toBeNull();
    if (process.platform === 'win32') {
      expect(address).toMatch(/^\\\\\.\\pipe\\vx-test-\d+-[0-9a-f]{12}$/);
    } else {
      expect(path.isAbsolute(address)).toBe(true);
      expect(existsSync(path.dirname(address))).toBe(false);
    }
    expect(server.listening).toBe(false);
  });

  it('uses a distinct directory per call and removes each one', async () => {
    const dirs = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const server = serverOf((_req, res) => res.end(JSON.stringify({ a: server.address() })));
      const res = await privateSocketRequest(server).get('/');
      dirs.add(path.dirname(JSON.parse(res.text).a as string));
    }
    if (process.platform !== 'win32') {
      expect(dirs.size).toBe(3);
      for (const dir of dirs) expect(existsSync(dir)).toBe(false);
    }
  });
});

describe('loopbackRequest transport', () => {
  it('listens on 127.0.0.1 only: the app sees a loopback peer, and no other server can take the address and port', async () => {
    let port = 0;
    const server = serverOf((req, res) => {
      port = (server.address() as net.AddressInfo).port;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ address: server.address(), peer: req.socket.remoteAddress }));
    });
    const lease = loopbackRequest(server).get('/where');
    const pending = lease.then((res) => res);
    // While the request is in flight, a rival asking the same address and port gets EADDRINUSE (no silent takeover).
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const rival = http.createServer();
    const clash = await new Promise<string>((resolve) => {
      rival.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'other'));
      rival.listen((server.address() as net.AddressInfo).port, '127.0.0.1', () => resolve('bound'));
    });
    if (rival.listening) rival.close();
    expect(clash).toBe('EADDRINUSE');
    const res = await pending;
    expect(res.body.address).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port });
    expect(res.body.peer).toBe('127.0.0.1');
    expect(server.listening).toBe(false);
  });
});

describe('immunity to a foreign server on the port the old mechanism used', () => {
  // Reproduces the incident: whenever a server listens on the wildcard address (what supertest's `request(server)` does),
  // another "process" binds 127.0.0.1 on the same port and answers 401. macOS allows that bind (SO_REUSEADDR) and the
  // foreign server then wins the connection to 127.0.0.1:<port>; Linux refuses the bind (EADDRINUSE), so nothing collides.
  let collided = 0;
  let wildcardListens = 0;
  const foreign: Server[] = [];
  const originalListen = net.Server.prototype.listen;

  function installForeignServer(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (net.Server.prototype as any).listen = function patched(this: net.Server, ...args: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (originalListen as any).apply(this, args);
      this.once('listening', () => {
        const address = this.address();
        if (!address || typeof address === 'string' || (address.address !== '::' && address.address !== '0.0.0.0') || foreign.includes(this as Server)) return;
        wildcardListens++;
        const rival = http.createServer((_req, res) => res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"_tag":"UnauthorizedError","message":"Authentication required"}'));
        foreign.push(rival);
        rival.once('error', () => undefined);
        rival.listen(address.port, '127.0.0.1', () => collided++);
      });
      return result;
    };
  }

  afterEach(() => {
    net.Server.prototype.listen = originalListen;
    for (const rival of foreign.splice(0)) if (rival.listening) rival.close();
    collided = 0;
    wildcardListens = 0;
  });

  const app: RequestListener = (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"from":"the app"}');

  it('control: the old mechanism (wildcard listen, then connect to 127.0.0.1) reads the foreign answer when the OS lets it bind', async () => {
    installForeignServer();
    const server = serverOf(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    // Same wait for the foreign bind as supertest never has: it connects at once, so give the bind a tick to be in place.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, path: '/', agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }).on('error', reject);
    });
    expect(wildcardListens).toBe(1);
    expect(status).toBe(collided > 0 ? 401 : 200);
  });

  it.each([
    ['privateSocketRequest', privateSocketRequest],
    ['loopbackRequest', loopbackRequest],
  ])('%s: the app answers, whatever a foreign server does on the wildcard-listened ports', async (_name, request) => {
    installForeignServer();
    for (let i = 0; i < 20; i++) {
      const res = await request(serverOf(app)).get('/');
      expect([res.status, res.body]).toEqual([200, { from: 'the app' }]);
    }
    // The helper never listens on a wildcard address, so there is no port a foreign server could share.
    expect([wildcardListens, collided]).toEqual([0, 0]);
  });
});
