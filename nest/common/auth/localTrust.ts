/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * "Local trust" mode: a single-user desktop app skips the admin key. Pure helpers, no Nest dependency.
 *
 * A request is trusted only when ALL of these hold:
 *  - the TCP peer (`req.socket.remoteAddress`) is a loopback address. `req.ip` and `X-Forwarded-For` are never used
 *    because `trust proxy` (see `configureHttpApp`) makes them client-controlled;
 *  - no proxy header (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`) is present: a local reverse proxy relays remote traffic;
 *  - `Host` is a loopback name (`127.0.0.1`, `localhost`, `[::1]`) on the listening port (blocks DNS rebinding);
 *  - `Origin` is absent or an http(s) loopback origin (blocks cross-site pages aimed at the local port).
 */

export type LocalTrustEnv = Record<string, string | undefined>;

export interface LocalTrustRequest {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | null;
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'];

/** True for the values of `LOCAL_TRUST` that enable the mode (`true`, `1`). */
export function isLocalTrustEnabled(env: LocalTrustEnv = process.env): boolean {
  return /^(true|1)$/i.test(env.LOCAL_TRUST?.trim() ?? '');
}

/** True for `127.0.0.0/8`, `::1` and their IPv4-mapped forms. */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || /^127(\.\d{1,3}){3}$/.test(a);
}

/** True for a listen host that only accepts local connections. */
export function isLoopbackListenHost(host: string | null | undefined): boolean {
  const h = (host ?? '').trim().toLowerCase();
  return h === 'localhost' || h === '[::1]' || isLoopbackAddress(h);
}

/** Throws when local trust is enabled while the server listens on a non-loopback host. */
export function assertLocalTrustHost(listenHost: string, env: LocalTrustEnv = process.env): void {
  if (isLocalTrustEnabled(env) && !isLoopbackListenHost(listenHost)) {
    throw new Error(
      `[SECURITY] LOCAL_TRUST=true requires HOST to be a loopback address (127.0.0.1, ::1 or localhost), got "${listenHost}".`,
    );
  }
}

function splitHostPort(value: string): { hostname: string; port: string } | null {
  const m = /^(\[[0-9a-f:]+\]|[^:[\]]+)(?::(\d{1,5}))?$/i.exec(value.trim());
  return m ? { hostname: m[1].toLowerCase(), port: m[2] ?? '' } : null;
}

/** `Host` header check: loopback name, and the listening port when known (an absent port means the default one). */
export function isLocalHostHeader(host: string | undefined, port: string | undefined): boolean {
  if (!host) return false;
  const parsed = splitHostPort(host);
  if (!parsed || !LOOPBACK_NAMES.has(parsed.hostname)) return false;
  return !port || parsed.port === port;
}

/** `Origin` check: absent is fine (same-origin GET, curl, native clients); otherwise an http(s) loopback origin. */
export function isLocalOrigin(origin: string | string[] | undefined): boolean {
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_NAMES.has(url.hostname.toLowerCase());
}

/** Whether `req` may be treated as the local administrator. The caller still checks `isLocalTrustEnabled`. */
export function isLocalTrustRequest(req: LocalTrustRequest, env: LocalTrustEnv = process.env): boolean {
  const headers = req.headers ?? {};
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  if (PROXY_HEADERS.some((h) => headers[h] !== undefined)) return false;
  const host = headers['host'];
  if (typeof host !== 'string' || !isLocalHostHeader(host, env.NODE_PORT?.trim() || undefined)) return false;
  return isLocalOrigin(headers['origin']);
}
