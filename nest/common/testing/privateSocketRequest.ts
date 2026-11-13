/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http, { type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Test helper: an HTTP client for specs that call a Nest/Express app in-process, with the part of supertest's API the
 * specs use (`request(server).get(path).set(h, v).send(body).expect(status)`), but without a TCP port shared with the
 * other processes of the machine.
 *
 * Why not supertest. `request(server)` makes the server listen on the wildcard address (port P), then connects to
 * 127.0.0.1:P. On macOS a server of another process bound to 127.0.0.1 on that same port takes the connection (SO_REUSEADDR
 * lets a specific bind sit on a wildcard one) and the spec reads ITS answer (a 401 "Authentication required", no body of its
 * own) or waits for one that never comes. Several specs of the libraries listen on 127.0.0.1 with an ephemeral port, so it
 * shows up as an intermittent failure of a full run on a loaded machine, never alone.
 *
 * Two transports, both without a wildcard bind:
 * - `privateSocketRequest` (default, to be preferred): the server listens on a private unix socket in a fresh `mkdtemp`
 *   directory (a uniquely named pipe on Windows). There is no port: nothing else can answer. The connection has NO TCP
 *   peer (`req.socket.remoteAddress` and `req.ip` are undefined).
 * - `loopbackRequest`: for a spec whose subject reads the TCP peer (local trust, client IP, per-IP throttling). The server
 *   listens on 127.0.0.1 explicitly: a specific bind cannot be duplicated (another process asking the same address and
 *   port gets EADDRINUSE, never a silent hijack) and wins over any wildcard bind of the same port, and the peer seen by the
 *   app is 127.0.0.1 as with supertest.
 *
 * The server is started by the first in-flight request of a server and closed (and its socket directory removed) when the
 * last one settles, like supertest does, so `app.close()` afterwards keeps working. A server that already listens is used
 * where it is (a private path or a specific address), never closed by the helper; one bound to a wildcard address is
 * refused (that is the unsafe case).
 *
 * Test code only: not exported by the module index, nothing in production imports it.
 */

/** What a request resolves to. `body` is the parsed JSON (`{}` when the answer is not JSON), `text` the decoded answer. */
export interface PrivateSocketResponse {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
}

export type PrivateSocketMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

/** `request(server)`: one factory per HTTP method, like supertest. Reusable for any number of requests. */
export type PrivateSocketRequester = Record<PrivateSocketMethod, (path: string) => PrivateSocketTest>;

/** What `request()` accepts: the Node server (`app.getHttpServer()`) or a request listener (an Express app). */
export type PrivateSocketTarget = Server | RequestListener;

type Endpoint = { socketPath: string } | { host: string; port: number };
type Transport = 'socket' | 'loopback';

interface Lease {
  endpoint: Endpoint;
  /** Set when this helper started the server (it then also closes it); undefined for a server that was already listening. */
  owned?: { dir?: string };
  users: number;
  ready: Promise<void>;
  closed?: Promise<void>;
}

const leases = new WeakMap<Server, Lease>();

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function listen(server: Server, options: http.ServerOptions & { path?: string; host?: string; port?: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(options as never, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

function endpointOfListening(server: Server): Endpoint | undefined {
  // `address()` of a server that listened on a socket path keeps answering that path after close(): trust `listening`.
  const address = server.listening ? server.address() : null;
  if (!address) return undefined;
  if (typeof address === 'string') return { socketPath: address };
  if (address.address === '::' || address.address === '0.0.0.0') {
    throw new Error(
      `the server already listens on the wildcard address (port ${address.port}): any other process bound to 127.0.0.1 on that port could answer instead. Let the helper start it, or listen on 127.0.0.1.`,
    );
  }
  return { host: address.address, port: address.port };
}

async function acquire(server: Server, transport: Transport): Promise<Lease> {
  for (;;) {
    const existing = leases.get(server);
    if (!existing) break;
    if (existing.closed) {
      await existing.closed;
      continue;
    }
    existing.users++;
    try {
      await existing.ready;
    } catch (err) {
      existing.users--;
      throw err;
    }
    return existing;
  }
  const already = endpointOfListening(server);
  if (already) {
    const lease: Lease = { endpoint: already, users: 1, ready: Promise.resolve() };
    leases.set(server, lease);
    return lease;
  }
  const owned: { dir?: string } = {};
  const lease: Lease = { endpoint: { socketPath: '' }, owned, users: 1, ready: Promise.resolve() };
  if (transport === 'loopback') {
    lease.ready = listen(server, { host: '127.0.0.1', port: 0 }).then(() => {
      lease.endpoint = { host: '127.0.0.1', port: (server.address() as { port: number }).port };
    });
  } else {
    let socketPath: string;
    if (process.platform === 'win32') {
      socketPath = `\\\\.\\pipe\\vx-test-${process.pid}-${randomBytes(6).toString('hex')}`;
    } else {
      owned.dir = mkdtempSync(path.join(tmpdir(), 'vxs-'));
      socketPath = path.join(owned.dir, 's');
    }
    lease.endpoint = { socketPath };
    lease.ready = listen(server, { path: socketPath });
  }
  leases.set(server, lease);
  try {
    await lease.ready;
  } catch (err) {
    leases.delete(server);
    if (owned.dir) rmSync(owned.dir, { recursive: true, force: true });
    throw err;
  }
  return lease;
}

/** Resolves once the server this helper started is closed and its directory removed (immediately for the other cases). */
function release(server: Server, lease: Lease): Promise<void> {
  if (--lease.users > 0) return Promise.resolve();
  if (!lease.owned) {
    leases.delete(server);
    return Promise.resolve();
  }
  const dir = lease.owned.dir;
  lease.closed = new Promise<void>((resolve) => {
    // The callback gets ERR_SERVER_NOT_RUNNING when something else already closed the server: nothing left to do then.
    server.close(() => resolve());
    server.closeAllConnections?.();
  }).finally(() => {
    leases.delete(server);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  return lease.closed;
}

function decode(buffer: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(buffer);
    case 'deflate':
      return zlib.inflateSync(buffer);
    case 'br':
      return zlib.brotliDecompressSync(buffer);
    default:
      return buffer;
  }
}

/** The request being built. Awaiting it (or `.then`) sends it, once. Same chain as supertest: `.set().send().expect()`. */
export class PrivateSocketTest implements PromiseLike<PrivateSocketResponse> {
  private readonly headers = new Map<string, { name: string; value: string }>();
  private payload: unknown;
  private redirectLimit = 0;
  private readonly expectations: Array<(res: PrivateSocketResponse) => void> = [];
  private sent?: Promise<PrivateSocketResponse>;

  constructor(
    private readonly server: Server,
    private readonly transport: Transport,
    private readonly method: string,
    private path: string,
  ) {
    // superagent's default, which decides whether an app compresses (the compression specs rely on it).
    this.headers.set('accept-encoding', { name: 'Accept-Encoding', value: 'gzip, deflate' });
  }

  set(name: string | Record<string, string | number>, value?: string | number | readonly string[]): this {
    if (typeof name === 'object') {
      for (const [key, entry] of Object.entries(name)) this.set(key, entry);
      return this;
    }
    this.headers.set(name.toLowerCase(), { name, value: Array.isArray(value) ? value.join(', ') : String(value) });
    return this;
  }

  unset(name: string): this {
    this.headers.delete(name.toLowerCase());
    return this;
  }

  /** Content-Type: `json`, `form`, `text`, `html` or a full media type. */
  type(type: string): this {
    const known: Record<string, string> = { json: 'application/json', form: 'application/x-www-form-urlencoded', text: 'text/plain', html: 'text/html' };
    return this.set('Content-Type', known[type] ?? type);
  }

  query(query: string | Record<string, unknown>): this {
    const text = typeof query === 'string' ? query : new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    if (text) this.path += (this.path.includes('?') ? '&' : '?') + text;
    return this;
  }

  /** An object is sent as JSON (unless a Content-Type is set), a string as it is (form-encoded unless a Content-Type is set). */
  send(data: unknown): this {
    if (typeof data === 'object' && data !== null && !Buffer.isBuffer(data) && typeof this.payload === 'object' && this.payload !== null && !Buffer.isBuffer(this.payload)) {
      this.payload = { ...(this.payload as object), ...(data as object) };
    } else {
      this.payload = data;
    }
    return this;
  }

  /** Follow up to `count` redirects to a path of the same server (none by default, like supertest). */
  redirects(count: number): this {
    this.redirectLimit = count;
    return this;
  }

  /** `.expect(201)`, `.expect([200, 404])`, `.expect(200, body)`: a mismatch rejects the request, like supertest. */
  expect(status: number | readonly number[], body?: unknown): this {
    if (typeof status !== 'number' && !Array.isArray(status)) throw new TypeError('PrivateSocketTest.expect() only supports a status code (or a list) and an optional body');
    const accepted = typeof status === 'number' ? [status] : [...(status as readonly number[])];
    this.expectations.push((res) => {
      if (!accepted.includes(res.status)) {
        throw new Error(`expected ${accepted.map((code) => `${code} "${http.STATUS_CODES[code]}"`).join(' or ')}, got ${res.status} "${res.statusText}"`);
      }
      if (body !== undefined) assert.deepStrictEqual(res.body, body);
    });
    return this;
  }

  then<R1 = PrivateSocketResponse, R2 = never>(
    onfulfilled?: ((value: PrivateSocketResponse) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    this.sent ??= this.run();
    return this.sent.then(onfulfilled, onrejected);
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<PrivateSocketResponse | R> {
    return this.then(undefined, onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<PrivateSocketResponse> {
    return this.then().finally(onfinally);
  }

  private async run(): Promise<PrivateSocketResponse> {
    const lease = await acquire(this.server, this.transport);
    try {
      let method = this.method;
      let target = this.path;
      let payload = this.payload;
      const headers = new Map(this.headers);
      for (let hops = 0; ; hops++) {
        const res = await this.exchange(lease.endpoint, method, target, headers, payload);
        const location = res.headers.location;
        if (!REDIRECT_STATUSES.has(res.status) || !location || hops >= this.redirectLimit) {
          for (const check of this.expectations) check(res);
          return res;
        }
        const next = new URL(location, 'http://private.invalid');
        if (next.host !== 'private.invalid') return this.finish(res); // another host: not ours to follow
        target = next.pathname + next.search;
        if (res.status !== 307 && res.status !== 308) {
          method = method === 'HEAD' ? 'HEAD' : 'GET';
          payload = undefined;
          headers.delete('content-type');
          headers.delete('content-length');
        }
      }
    } finally {
      await release(this.server, lease);
    }
  }

  private finish(res: PrivateSocketResponse): PrivateSocketResponse {
    for (const check of this.expectations) check(res);
    return res;
  }

  private exchange(
    endpoint: Endpoint,
    method: string,
    target: string,
    headers: Map<string, { name: string; value: string }>,
    payload: unknown,
  ): Promise<PrivateSocketResponse> {
    const sending = new Map(headers);
    let data: Buffer | undefined;
    if (payload !== undefined && payload !== null) {
      if (Buffer.isBuffer(payload)) data = payload;
      else if (typeof payload === 'string') data = Buffer.from(payload);
      else data = Buffer.from(JSON.stringify(payload));
      if (!sending.has('content-type')) {
        sending.set('content-type', { name: 'Content-Type', value: typeof payload === 'string' ? 'application/x-www-form-urlencoded' : Buffer.isBuffer(payload) ? 'application/octet-stream' : 'application/json' });
      }
      sending.set('content-length', { name: 'Content-Length', value: String(data.length) });
    }
    const flat: Record<string, string> = {};
    for (const { name, value } of sending.values()) flat[name] = value;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const req = http.request({ ...endpoint, method, path: target, headers: flat, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', fail);
        res.on('close', () => {
          if (!res.complete) fail(new Error('the connection closed before the answer was complete'));
        });
        res.on('end', () => {
          if (settled) return;
          try {
            const raw = method === 'HEAD' ? Buffer.alloc(0) : decode(Buffer.concat(chunks), res.headers['content-encoding']);
            const text = raw.toString('utf8');
            let body: unknown = {};
            if (/[/+]json\b/i.test(res.headers['content-type'] ?? '') && text) {
              try {
                body = JSON.parse(text);
              } catch {
                body = {};
              }
            }
            settled = true;
            resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? http.STATUS_CODES[res.statusCode ?? 0] ?? '', headers: res.headers, body, text });
          } catch (err) {
            fail(err as Error);
          }
        });
      });
      // An early answer (413 on a large body) may be followed by a reset while the body is still being written: the
      // answer wins, the late error is ignored (`fail` does nothing once settled; before the answer it rejects).
      req.on('error', fail);
      req.end(data);
    });
  }
}

function requester(target: PrivateSocketTarget, transport: Transport): PrivateSocketRequester {
  const server = typeof target === 'function' ? http.createServer(target) : target;
  const make = (method: PrivateSocketMethod) => (requestPath: string) => new PrivateSocketTest(server, transport, method.toUpperCase(), requestPath);
  return { get: make('get'), post: make('post'), put: make('put'), patch: make('patch'), delete: make('delete'), head: make('head'), options: make('options') };
}

/** `request(app.getHttpServer()).get('/x')` over a private unix socket (named pipe on Windows): no TCP port at all. */
export function privateSocketRequest(target: PrivateSocketTarget): PrivateSocketRequester {
  return requester(target, 'socket');
}

/** Same, over 127.0.0.1 with a specific bind, for a spec whose subject reads the TCP peer address (see the header). */
export function loopbackRequest(target: PrivateSocketTarget): PrivateSocketRequester {
  return requester(target, 'loopback');
}
