/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Network guard against server-side request forgery (04 §14), extracted from AgentHub (`hq/connectors/connectorNet.ts`).
// An address a user gives (a Web Push endpoint, a webhook URL) must never reach the app's own network: loopback, private,
// link-local (cloud metadata 169.254.169.254 among them), shared, reserved and multicast ranges, IPv6 included (NAT64
// and 6to4 checked against the IPv4 ranges). The check happens WHEN THE CONNECTION IS MADE (`guardedLookup`, the
// `lookup` hook of the socket), so a name that resolves to a public address at validation and to a private one at send
// time (DNS rebinding) is refused. Differences with the source: errors carry a CODE only (`ADDRESS_REFUSED`,
// `REDIRECT_REFUSED`, `HTTPS_REQUIRED`, `CREDENTIALS_IN_URL`), never the host, and `guardedFetch` follows no redirect
// by default (a webhook POST is one request).

import http from 'http';
import https from 'https';
import type { LookupAddress } from 'dns';
import { lookup as dnsLookup } from 'dns/promises';
import { BlockList, isIP, type LookupFunction, type Socket } from 'net';
import type { Duplex } from 'stream';

export type NetGuardCode = 'ADDRESS_REFUSED' | 'REDIRECT_REFUSED' | 'HTTPS_REQUIRED' | 'CREDENTIALS_IN_URL' | 'INVALID_URL' | 'NETWORK' | 'TIMEOUT';

/** A refused or failed outbound call; `message` is the code itself (never a host, a path or a credential). */
export class NetGuardError extends Error {
  constructor(readonly code: NetGuardCode) {
    super(code);
    this.name = 'NetGuardError';
  }
}

export interface AddressGuard {
  /** An administrator's own target may reach private ranges (checked at send time with `directory.isAdmin`). */
  allowPrivate: boolean;
  resolve(hostname: string): Promise<LookupAddress[]>;
  isBlocked(address: string): boolean;
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_V6: Array<[string, number]> = [
  ['::', 96],
  // IPv4-translated (SIIT, RFC 6052 §2.2 / RFC 7915): `::ffff:0:a.b.c.d` reaches an IPv4 host through a translator.
  ['::ffff:0:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

const BLOCKED = new BlockList();
for (const [network, prefix] of BLOCKED_V4) BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of BLOCKED_V6) BLOCKED.addSubnet(network, prefix, 'ipv6');

/** The 16 bytes of an IPv6 address (`::` expanded, a trailing dotted IPv4 accepted), or `null`. */
function ipv6Bytes(ip: string): number[] | null {
  let text = ip;
  const tail: number[] = [];
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    tail.push(...dotted[1].split('.').map(Number));
    text = `${text.slice(0, dotted.index + 1)}0:0`;
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (rest === undefined && missing !== 0)) return null;
  const groups = [...left, ...new Array<string>(rest === undefined ? 0 : missing).fill('0'), ...right].map((group) => parseInt(group, 16));
  if (groups.length !== 8 || groups.some((group) => !Number.isFinite(group) || group < 0 || group > 0xffff)) return null;
  const bytes = groups.flatMap((group) => [group >> 8, group & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** The IPv4 address an IPv6 one carries by construction: NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`). */
function embeddedIpv4(ip: string): string | null {
  const bytes = ipv6Bytes(ip);
  if (!bytes) return null;
  const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((byte) => byte === 0);
  if (nat64) return bytes.slice(12, 16).join('.');
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6).join('.');
  return null;
}

/** True for every address a user's target must not reach; anything that is not an IP address is blocked too. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0];
  const family = isIP(ip);
  if (family === 4) return BLOCKED.check(ip, 'ipv4');
  if (family !== 6) return true;
  if (BLOCKED.check(ip, 'ipv6')) return true;
  const embedded = embeddedIpv4(ip);
  return embedded !== null && BLOCKED.check(embedded, 'ipv4');
}

/** Every address of a name (A and AAAA), as the system resolver answers now. */
export function resolveAll(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

/** The default guard: the system resolver and the ranges above. */
export function defaultGuard(allowPrivate = false): AddressGuard {
  return { allowPrivate, resolve: resolveAll, isBlocked: isBlockedAddress };
}

async function checkedAddresses(hostname: string, guard: AddressGuard): Promise<LookupAddress[]> {
  let addresses: LookupAddress[];
  try {
    addresses = await guard.resolve(hostname);
  } catch {
    throw new NetGuardError('ADDRESS_REFUSED');
  }
  if (addresses.length === 0) throw new NetGuardError('ADDRESS_REFUSED');
  if (!guard.allowPrivate && addresses.some((entry) => guard.isBlocked(entry.address))) throw new NetGuardError('ADDRESS_REFUSED');
  return addresses;
}

/** The host of a URL judged now: a literal IP against the ranges, a name through a fresh resolution. */
export async function assertReachable(url: URL, guard: AddressGuard): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new NetGuardError('ADDRESS_REFUSED');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!guard.allowPrivate && guard.isBlocked(host)) throw new NetGuardError('ADDRESS_REFUSED');
    return;
  }
  await checkedAddresses(host, guard);
}

/** The `lookup` hook of a socket: the addresses it may connect to, checked at connection time (rebinding included). */
export function guardedLookup(guard: AddressGuard): LookupFunction {
  return (hostname, options, callback) => {
    checkedAddresses(hostname, guard).then(
      (addresses) => {
        const wanted = options.family === 4 || options.family === 6 ? addresses.filter((entry) => entry.family === options.family) : addresses;
        if (wanted.length === 0) return callback(new NetGuardError('ADDRESS_REFUSED'), '', 0);
        if (options.all) return callback(null, wanted);
        return callback(null, wanted[0].address, wanted[0].family);
      },
      (err: Error) => callback(err, '', 0),
    );
  };
}

/** Bounds of one outbound socket: a hard deadline (whatever the activity) and the bytes it may receive. */
export interface SocketLimits {
  deadlineMs: number;
  maxBytes: number;
}

/**
 * Destroys `socket` once `deadlineMs` have passed since now (a target that trickles data defeats an idle timeout) or
 * as soon as it has received more than `maxBytes`: `TIMEOUT` / `NETWORK`, never a host in the error. The bytes are
 * counted by a `data` listener added when the socket is created: the HTTP client adds its own on the next tick, before
 * any byte can arrive, and every listener receives every chunk (counting takes nothing from the client).
 */
export function limitSocket(socket: Socket | Duplex, limits: SocketLimits): void {
  const deadline = setTimeout(() => socket.destroy(new NetGuardError('TIMEOUT')), Math.max(1, limits.deadlineMs));
  deadline.unref?.();
  let received = 0;
  const count = (chunk: Buffer | string): void => {
    received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (received > limits.maxBytes) socket.destroy(new NetGuardError('NETWORK'));
  };
  socket.on('data', count);
  socket.once('close', () => {
    clearTimeout(deadline);
    socket.off('data', count);
  });
}

/** An `https.Agent` whose sockets are resolved through the guard and, with `limits`, bounded (`limitSocket`). */
class GuardedHttpsAgent extends https.Agent {
  constructor(
    options: https.AgentOptions,
    private readonly limits: SocketLimits | null,
  ) {
    super(options);
  }

  override createConnection(...args: Parameters<https.Agent['createConnection']>): ReturnType<https.Agent['createConnection']> {
    const socket = super.createConnection(...args);
    if (socket && this.limits) limitSocket(socket, this.limits);
    return socket;
  }
}

/** An `https.Agent` whose sockets resolve through the guard (for libraries that take an agent, such as `web-push`). */
export function guardedHttpsAgent(guard: AddressGuard, limits?: SocketLimits): https.Agent {
  return new GuardedHttpsAgent({ lookup: guardedLookup(guard), keepAlive: false }, limits ?? null);
}

/**
 * A webhook-style URL a user gives (04 §5, §14): `https` (an administrator may use `http`), no user name nor password,
 * no fragment, 2 048 characters at most. The address is judged by `assertReachable` at write time and again at send.
 */
export function validateTargetUrl(value: unknown, options: { admin: boolean; maxLength?: number }): URL {
  const max = options.maxLength ?? 2048;
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new NetGuardError('INVALID_URL');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new NetGuardError('INVALID_URL');
  }
  const allowed = options.admin ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(url.protocol)) throw new NetGuardError('HTTPS_REQUIRED');
  if (url.username || url.password) throw new NetGuardError('CREDENTIALS_IN_URL');
  url.hash = '';
  return url;
}

export interface GuardedResponse {
  status: number;
  /** Body text, read up to `maxBodyBytes` (the rest is dropped). */
  body: string;
}

export interface GuardedRequest {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Bytes of the response body kept (default 4 096). */
  maxBodyBytes?: number;
}

/**
 * ONE HTTP exchange through the guard: a literal IP is checked before the request, a name at connection time; a
 * redirect is never followed (`REDIRECT_REFUSED`); a fresh socket per call (`agent: false`). Throws `NetGuardError`.
 */
export async function guardedRequest(target: URL, request: GuardedRequest, guard: AddressGuard): Promise<GuardedResponse> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new NetGuardError('ADDRESS_REFUSED');
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !guard.allowPrivate && guard.isBlocked(host)) throw new NetGuardError('ADDRESS_REFUSED');
  const response = await exchange(target, request, guard);
  if (response.status >= 300 && response.status < 400) throw new NetGuardError('REDIRECT_REFUSED');
  return response;
}

function exchange(url: URL, request: GuardedRequest, guard: AddressGuard): Promise<GuardedResponse> {
  const maxBytes = request.maxBodyBytes ?? 4096;
  return new Promise<GuardedResponse>((resolve, reject) => {
    const headers = { ...(request.headers ?? {}), ...(request.body !== undefined ? { 'content-length': String(Buffer.byteLength(request.body)) } : {}) };
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method: request.method, headers, lookup: guardedLookup(guard), agent: false, timeout: request.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size < maxBytes) chunks.push(chunk.subarray(0, maxBytes - size));
        size += chunk.length;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => reject(new NetGuardError('NETWORK')));
    });
    req.on('timeout', () => req.destroy(new NetGuardError('TIMEOUT')));
    req.on('error', (err: Error) => reject(err instanceof NetGuardError ? err : new NetGuardError('NETWORK')));
    req.end(request.body);
  });
}
