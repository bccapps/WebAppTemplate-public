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
 *  - `Host` is a loopback name (`127.0.0.1`, `localhost`, `[::1]`) on the listening port `NODE_PORT` (blocks DNS rebinding).
 *    With `APP_ENV=dev` only, the front dev server port `FRONT_PORT` is also accepted (the Vite proxy may keep the
 *    browser's `Host`; it adds no `X-Forwarded-*` header unless `xfwd` is set);
 *  - the browser context is the app's own: with no `Origin`, `Sec-Fetch-Site` is absent (non-browser client) or `same-origin`/`none`;
 *    with an `Origin`, it is a loopback http(s) origin equal to the app's own (the request `Host`) or listed in `CLIENT_ORIGINS`
 *    (or, with `APP_ENV=dev`, the front dev server `FRONT_PORT`). `Origin: null` (sandboxed frames), another loopback port and a
 *    cross-site/same-site fetch without allow-listed Origin are refused: a page served from this machine (an agent's dev server,
 *    a preview) must not act as the administrator.
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
export function isLocalHostHeader(host: string | undefined, port: string | string[] | undefined): boolean {
  if (!host) return false;
  const parsed = splitHostPort(host);
  if (!parsed || !LOOPBACK_NAMES.has(parsed.hostname)) return false;
  const ports = (Array.isArray(port) ? port : [port]).filter((p): p is string => !!p);
  return ports.length === 0 || ports.includes(parsed.port);
}

/** Ports accepted in `Host`: `NODE_PORT`, plus `FRONT_PORT` only when `APP_ENV=dev` (Vite proxy in development). */
export function allowedHostPorts(env: LocalTrustEnv = process.env): string[] {
  const ports = [env.NODE_PORT?.trim()];
  if (!ports[0]) return []; // unknown listening port: any port, as before
  if (env.APP_ENV?.trim().toLowerCase() === 'dev') ports.push(env.FRONT_PORT?.trim());
  return ports.filter((p): p is string => !!p);
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

/** Normalised `scheme://host:port` of an origin string (default ports kept implicit by `URL`), or `null` when it is not a URL. */
function normalizedOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Origins allowed to call the API with local-trust: the app's own (same host:port as the request `Host`, either scheme), the
 * `CLIENT_ORIGINS` allow-list (the CORS one) and, with `APP_ENV=dev`, the front dev server port on the loopback names.
 */
export function allowedLocalOrigins(host: string, env: LocalTrustEnv = process.env): string[] {
  const allowed = [`http://${host.toLowerCase()}`, `https://${host.toLowerCase()}`];
  for (const entry of (env.CLIENT_ORIGINS ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed === '*') continue;
    const normalized = normalizedOrigin(trimmed);
    if (normalized) allowed.push(normalized);
  }
  const frontPort = env.FRONT_PORT?.trim();
  if (env.APP_ENV?.trim().toLowerCase() === 'dev' && frontPort) {
    for (const name of LOOPBACK_NAMES) allowed.push(`http://${name}:${frontPort}`);
  }
  return allowed;
}

/**
 * Browser-context check (CSRF / foreign local pages). Without `Origin`: a non-browser client sends no `Sec-Fetch-Site` either, a
 * browser sends `same-origin` or `none` (address-bar navigation); `same-site`/`cross-site` are refused. With `Origin`: loopback,
 * and equal to the app's own origin or allow-listed; the opaque `null` origin never passes.
 */
export function isTrustedBrowserContext(headers: NonNullable<LocalTrustRequest['headers']>, host: string, env: LocalTrustEnv = process.env): boolean {
  const origin = headers['origin'];
  if (origin === undefined) {
    const site = headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
  }
  if (typeof origin !== 'string' || !isLocalOrigin(origin)) return false;
  const normalized = normalizedOrigin(origin);
  return normalized !== null && allowedLocalOrigins(host, env).includes(normalized);
}

/** Whether `req` may be treated as the local administrator. The caller still checks `isLocalTrustEnabled`. */
export function isLocalTrustRequest(req: LocalTrustRequest, env: LocalTrustEnv = process.env): boolean {
  const headers = req.headers ?? {};
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  if (PROXY_HEADERS.some((h) => headers[h] !== undefined)) return false;
  const host = headers['host'];
  if (typeof host !== 'string' || !isLocalHostHeader(host, allowedHostPorts(env))) return false;
  return isTrustedBrowserContext(headers, host, env);
}
