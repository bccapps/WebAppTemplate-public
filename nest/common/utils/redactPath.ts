/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** What replaces a secret-looking path segment in a log line. */
export const REDACTED_SEGMENT = '[redacted]';

/** Longest path written to a log line (after redaction). */
export const MAX_LOGGED_PATH_LENGTH = 200;

/**
 * Prefixes of the tokens known to travel in URLs (AgentHub: terminal share `acs_`, runner enrollment `ahe_`, federation
 * `ahf_`, issue intake `ahi_`, runner `ahr_`) and of common third-party secrets: a segment starting with one of them,
 * followed by at least 8 characters, is redacted whatever its length.
 */
export const SECRET_SEGMENT_PREFIXES: readonly string[] = [
  'acs_', 'ahe_', 'ahf_', 'ahi_', 'ahr_',
  'sk_', 'rk_', 'whsec_', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'github_pat_', 'glpat-', 'xoxb-', 'xoxp-', 'xkeysib-',
];

const TOKEN_CHARSET = /^[A-Za-z0-9_\-.~+=]+$/;
const MIN_TOKEN_LENGTH = 20;

function count(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Whether a path segment looks like a secret: a known token prefix, or at least 20 URL-safe characters that look random
 * (two digits or more, or both cases twice). Route words stay readable (`notification-channels`, `communication-topics`,
 * `wallet-intelligence-v2`); random tokens (base64url, hex, hashes) and UUIDs are redacted — a v4 UUID carries 122
 * random bits, the very shape of a capability token (share links, unsubscribe links), and the rest of the line (method,
 * other segments, IP, status) is enough to triage. Short numeric ids are kept.
 */
export function isSecretSegment(segment: string): boolean {
  const value = decodeSegment(segment);
  if (SECRET_SEGMENT_PREFIXES.some((prefix) => value.startsWith(prefix) && value.length >= prefix.length + 8)) return true;
  if (value.length < MIN_TOKEN_LENGTH || !TOKEN_CHARSET.test(value)) return false;
  return count(value, /[0-9]/g) >= 2 || (count(value, /[A-Z]/g) >= 2 && count(value, /[a-z]/g) >= 2);
}

/**
 * A request URL fit for a log line: query string and fragment dropped, secret-looking segments replaced by
 * `[redacted]`, cut at {@link MAX_LOGGED_PATH_LENGTH} characters.
 */
export function redactPath(url: string | null | undefined): string {
  const path = String(url ?? '').split(/[?#]/)[0];
  const redacted = path
    .split('/')
    .map((segment) => (segment && isSecretSegment(segment) ? REDACTED_SEGMENT : segment))
    .join('/');
  return redacted.length > MAX_LOGGED_PATH_LENGTH ? `${redacted.slice(0, MAX_LOGGED_PATH_LENGTH)}…` : redacted;
}

/**
 * Replaces the raw request URL (and its path without query) inside a text by its redacted form: Nest's 404 message
 * (`Cannot GET /api/v1/hooks/<secret>`) and the exception details quote it.
 */
export function redactUrlIn(text: string, rawUrl: string | null | undefined): string {
  const raw = String(rawUrl ?? '');
  if (!raw || !text) return text;
  const safe = redactPath(raw);
  const rawPath = raw.split(/[?#]/)[0];
  let out = text.split(raw).join(safe);
  if (rawPath && rawPath !== raw) out = out.split(rawPath).join(safe);
  return out;
}
