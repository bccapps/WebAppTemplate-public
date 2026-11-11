/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Interface session of a local-trust app (README « Session d'interface locale »). With `LOCAL_TRUST=true`, a genuine local request
 * (`localTrust.ts`) is the administrator. A local process that is not the app's window (an agent the app runs, a script, another
 * account's process on a shared machine) passes those checks too: loopback, no `Origin`. When the app is started with
 * `LOCAL_UI_BOOT_ANCHOR`, local trust ALSO requires the interface session, a secret only the window holds:
 *
 *  1. the launcher (the desktop shell) draws a one-time boot code, gives the back only its SHA-256 (`LOCAL_UI_BOOT_ANCHOR`, not a
 *     secret) and opens the window at `http://127.0.0.1:<port>/#vx-local-ui=<code>`: a URL fragment is never sent to a server nor logged;
 *  2. the page removes the fragment from its address and POSTs the code (`/api/v1/local-ui/session`): the back compares SHA-256(code)
 *     with the anchor in constant time, then forgets the anchor (single use: a replayed or second code is refused) and answers a random
 *     session token, kept only in the page's memory and `sessionStorage` (per origin, so per port; never a cookie, which is not);
 *  3. every request of the page carries it (`X-Local-Session`); tokens are stored hashed, compared in constant time, live
 *     {@link DEFAULT_TTL_MS} of the MONOTONIC clock without renewal (paused while the machine sleeps on macOS and Linux), and the page
 *     rotates its token every {@link DEFAULT_RENEW_AFTER_MS} (`/api/v1/local-ui/session/renew`: the old one still passes
 *     {@link DEFAULT_GRACE_MS} for the requests already sent, then never again).
 *
 * Nothing here weakens `isLocalTrustRequest`: the session is required IN ADDITION to its socket, Host and Origin checks.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isLocalTrustEnabled, type LocalTrustEnv, type LocalTrustRequest } from './localTrust';

/** Environment variable holding the SHA-256 (64 hex characters) of the launch's boot code. Set ⇒ the interface session is required. */
export const LOCAL_UI_BOOT_ANCHOR_ENV = 'LOCAL_UI_BOOT_ANCHOR';
/** Request header carrying the session token (lowercase, as Node exposes it). */
export const LOCAL_UI_SESSION_HEADER = 'x-local-session';
/** A token's life without renewal, in monotonic milliseconds. */
export const DEFAULT_TTL_MS = 12 * 60 * 60_000;
/** When the page renews its token (told to the page in every answer). */
export const DEFAULT_RENEW_AFTER_MS = 10 * 60_000;
/** How long a renewed token still passes (requests already sent with it). */
export const DEFAULT_GRACE_MS = 60_000;
/** Live tokens at most: the oldest goes first. */
export const DEFAULT_MAX_SESSIONS = 8;

const ANCHOR_RE = /^[0-9a-f]{64}$/i;
const CODE_RE = /^[0-9a-f]{64}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface LocalUiSessionOptions {
  ttlMs?: number;
  renewAfterMs?: number;
  graceMs?: number;
  maxSessions?: number;
  /** Monotonic clock in milliseconds (`performance.now`): wall-clock changes never extend nor cut a session. */
  now?: () => number;
}

/** What the page receives: its token, and when to renew it. Never logged. */
export interface IssuedLocalUiSession {
  token: string;
  ttlMs: number;
  renewAfterMs: number;
}

interface LiveSession {
  digest: Buffer;
  expiresAt: number;
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** Whether `value` is a well-formed anchor (64 hex characters). */
export function isLocalUiBootAnchor(value: string | undefined): boolean {
  return value !== undefined && ANCHOR_RE.test(value.trim());
}

/** The boot code exchange and the live session tokens of one back process. In memory only: a restart starts over. */
export class LocalUiSessionStore {
  private anchor: Buffer | null;
  private sessions: LiveSession[] = [];
  private readonly ttlMs: number;
  private readonly renewAfterMs: number;
  private readonly graceMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(anchorHex: string, options: LocalUiSessionOptions = {}) {
    if (!isLocalUiBootAnchor(anchorHex)) throw new Error(`[SECURITY] ${LOCAL_UI_BOOT_ANCHOR_ENV} must be 64 hexadecimal characters (the SHA-256 of the boot code)`);
    this.anchor = Buffer.from(anchorHex.trim(), 'hex');
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.renewAfterMs = options.renewAfterMs ?? DEFAULT_RENEW_AFTER_MS;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.now = options.now ?? (() => performance.now());
  }

  /** Whether the boot code was not exchanged yet. */
  get bootPending(): boolean {
    return this.anchor !== null;
  }

  /** Exchanges the boot code for a first session. Once: the anchor is forgotten on success, so a replayed code is refused. */
  exchange(code: unknown): IssuedLocalUiSession | null {
    if (this.anchor === null || typeof code !== 'string' || !CODE_RE.test(code)) return null;
    if (!timingSafeEqual(sha256(code.toLowerCase()), this.anchor)) return null;
    this.anchor = null;
    return this.issue();
  }

  /** Whether `token` is a live session token. */
  verify(token: unknown): boolean {
    return this.find(token) !== null;
  }

  /** A new token for a live one, which then only passes {@link DEFAULT_GRACE_MS} more (never longer than it had). */
  renew(token: unknown): IssuedLocalUiSession | null {
    const session = this.find(token);
    if (session === null) return null;
    session.expiresAt = Math.min(session.expiresAt, this.now() + this.graceMs);
    return this.issue();
  }

  private find(token: unknown): LiveSession | null {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    this.prune();
    const digest = sha256(token);
    let found: LiveSession | null = null;
    // Every live digest is compared (no early exit): the time taken does not depend on which one matches.
    for (const session of this.sessions) {
      if (timingSafeEqual(session.digest, digest)) found = session;
    }
    return found;
  }

  private issue(): IssuedLocalUiSession {
    this.prune();
    while (this.sessions.length >= this.maxSessions) this.sessions.shift();
    const token = randomBytes(32).toString('base64url');
    this.sessions.push({ digest: sha256(token), expiresAt: this.now() + this.ttlMs });
    return { token, ttlMs: this.ttlMs, renewAfterMs: this.renewAfterMs };
  }

  private prune(): void {
    const now = this.now();
    this.sessions = this.sessions.filter((session) => session.expiresAt > now);
  }
}

let shared: { anchor: string; store: LocalUiSessionStore } | null = null;

/**
 * The store of this process, or `null` when the interface session is not required (`LOCAL_TRUST` off, or no `LOCAL_UI_BOOT_ANCHOR`:
 * local trust then behaves as before). One store per anchor value: the auth provider and the exchange controller share it. Throws, so the
 * app refuses to start, on a malformed anchor under `LOCAL_TRUST` (fail closed: never a silent fallback to the bare local trust).
 */
export function localUiSessionStore(env: LocalTrustEnv = process.env): LocalUiSessionStore | null {
  const anchor = env[LOCAL_UI_BOOT_ANCHOR_ENV]?.trim();
  if (!anchor || !isLocalTrustEnabled(env)) return null;
  if (shared?.anchor !== anchor) shared = { anchor, store: new LocalUiSessionStore(anchor) };
  return shared.store;
}

/** The session token a request carries (`X-Local-Session`), `undefined` when absent or repeated. */
export function localUiSessionToken(req: LocalTrustRequest): string | undefined {
  const value = req.headers?.[LOCAL_UI_SESSION_HEADER];
  return typeof value === 'string' ? value : undefined;
}

/** Test helper: forget the process's store (the next {@link localUiSessionStore} builds a new one). */
export function resetLocalUiSessionStoreForTests(): void {
  shared = null;
}
