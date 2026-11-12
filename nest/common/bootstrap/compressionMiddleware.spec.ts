/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/// <reference types="@types/jest" />

import { AddressInfo } from 'net';
import { IncomingHttpHeaders, request } from 'http';
import type { Server } from 'http';
import { lazyCompression } from './compressionMiddleware';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express') as () => import('express').Express;

interface Capture {
  headers: IncomingHttpHeaders;
  arrivals: number[];
  body: string;
}

function startServer(contentType: string): Promise<Server> {
  const app = express();
  app.use(lazyCompression(() => 1024));
  app.post('/stream', (_req, res) => {
    res.setHeader('Content-Type', contentType);
    res.write('data: first\n\n');
    let ticks = 0;
    const timer = setInterval(() => {
      res.write(': keepalive\n\n');
      if (++ticks === 3) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function post(server: Server): Promise<Capture> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const req = request(
      { port: (server.address() as AddressInfo).port, path: '/stream', method: 'POST', headers: { 'Accept-Encoding': 'gzip, deflate, br' } },
      (res) => {
        const arrivals: number[] = [];
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          arrivals.push(Date.now() - start);
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ headers: res.headers, arrivals, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe('lazyCompression', () => {
  let server: Server;
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('never compresses a text/event-stream response: every write reaches the client as it is made', async () => {
    server = await startServer('text/event-stream');
    const { headers, arrivals, body } = await post(server);
    expect(headers['content-encoding']).toBeUndefined();
    expect(body).toBe('data: first\n\n: keepalive\n\n: keepalive\n\n: keepalive\n\n');
    expect(arrivals.length).toBeGreaterThanOrEqual(4);
    expect(arrivals[arrivals.length - 1] - arrivals[0]).toBeGreaterThanOrEqual(250);
  });

  it('still compresses another compressible streamed type', async () => {
    server = await startServer('text/plain');
    const { headers } = await post(server);
    expect(headers['content-encoding']).toBeDefined();
  });
});
