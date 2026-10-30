/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Environment shape read by the HTTP bootstrap helpers. */
export type HttpAppEnv = Record<string, string | undefined>;

/** Splits a comma-separated list, trimming blanks and dropping empty entries. */
export function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The CORS allow-list: `explicit`, else env `CLIENT_ORIGINS`, else `http://localhost:<FRONT_PORT>`. */
export function resolveClientOrigins(explicit: string | undefined, env: HttpAppEnv = process.env): string[] {
  return parseList(explicit ?? env.CLIENT_ORIGINS ?? `http://localhost:${env.FRONT_PORT}`);
}

let recordedOrigins: string[] | null = null;

/** Called by `configureHttpApp` with the allow-list it applies (so an explicit `clientOrigins` option wins over the env). */
export function recordAllowedClientOrigins(origins: readonly string[]): void {
  recordedOrigins = [...origins];
}

/** Forgets the recorded allow-list (tests). */
export function resetAllowedClientOrigins(): void {
  recordedOrigins = null;
}

/**
 * The front origins of this back: the CORS allow-list applied by `configureHttpApp`, or, before it ran (scripts,
 * tests), the one resolved from the environment. May contain `*` outside production.
 */
export function allowedClientOrigins(env: HttpAppEnv = process.env): string[] {
  return recordedOrigins ? [...recordedOrigins] : resolveClientOrigins(undefined, env);
}

/** `http(s)` origin of an allow-list entry (`https://a.io/` → `https://a.io`), `null` for `*` or anything else. */
function httpOrigin(entry: string): string | null {
  try {
    const url = new URL(entry);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Validates a URL the back will redirect a browser to (e.g. Stripe Checkout `success_url`): an absolute `http(s)` URL
 * whose origin is one of `origins`, or a path starting with a single `/`, resolved against the first `http(s)` origin
 * of the list. Returns the normalized URL, or `null` when refused (foreign origin, protocol-relative `//host`,
 * `javascript:`, credentials in the URL, no usable origin in the list — `*` never matches).
 */
export function resolveFrontRedirectUrl(candidate: string, origins: readonly string[]): string | null {
  const allowed = origins.map(httpOrigin).filter((origin): origin is string => origin !== null);
  const value = typeof candidate === 'string' ? candidate.trim() : '';
  if (allowed.length === 0 || !value) return null;
  const absolute = ABSOLUTE_URL.test(value);
  if (!absolute && !value.startsWith('/')) return null;
  let url: URL;
  try {
    url = absolute ? new URL(value) : new URL(value, allowed[0]);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const accepted = absolute ? allowed.includes(url.origin) : url.origin === allowed[0];
  return accepted ? url.href : null;
}
