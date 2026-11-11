/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Interface session of a local-trust app, page side (back: `nest/common/auth/localUiSession.ts`, README « Session d'interface locale »).
 * Inert unless the page was opened with a boot code (`#vx-local-ui=<code>`, the desktop shell does it) or a tab of the same origin holds a
 * session: then
 *  - the code is removed from the address at once, then exchanged (`POST <api>/local-ui/session`) for a session token; every HTTP call waits
 *    for that exchange;
 *  - the token goes on every SAME-ORIGIN request as `X-Local-Session` (the axios interceptor installed here, `HttpService` streams,
 *    `localUiSessionHeaders()` for a hand-made `fetch`); never on another origin's request;
 *  - it is kept in memory and `sessionStorage` (per origin, so per port; a reload keeps it; never `localStorage` nor a cookie), rotated every
 *    `renewAfterMs` the back sent, and handed to another tab of the same origin over a `BroadcastChannel` (a new tab asks, a tab that rotated
 *    tells the others).
 */

import axios from 'axios';
import { DEFAULT_API_URL } from './apiBase';

export const LOCAL_UI_SESSION_HEADER = 'X-Local-Session';
/** Fragment key of the boot code (the desktop shell's `environment.rs` `UI_BOOT_FRAGMENT_KEY`). */
export const LOCAL_UI_BOOT_FRAGMENT_KEY = 'vx-local-ui';

const STORAGE_KEY = 'vx.localUi.session';
/** Not a secret: tells a new tab of this origin to ask the others for their session before its first request. */
const USED_MARKER_KEY = 'vx.localUi.used';
const CHANNEL_NAME = 'vx-local-ui';
const ASK_PEERS_MS = 400;
const EXCHANGE_TIMEOUT_MS = 15_000;
const EXCHANGE_ATTEMPTS = 3;
const RETRY_RENEW_MS = 60_000;
const DEFAULT_RENEW_AFTER_MS = 10 * 60_000;
const CODE_RE = /^[0-9a-f]{64}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

interface Issued {
  token: string;
  renewAfterMs: number;
}

type PeerMessage = { type: 'ask' } | { type: 'token'; token: string; renewAfterMs: number };

export type LocalUiSessionState = 'unused' | 'active' | 'lost';

let token: string | null = null;
/** When this page got its current token (`Date.now()`): a page woken from a long pause renews at once. */
let adoptedAt = 0;
let renewAfterMs = DEFAULT_RENEW_AFTER_MS;
let used = false;
let lost = false;
let pending: Promise<void> | null = null;
let renewTimer: ReturnType<typeof setTimeout> | null = null;
let channel: BroadcastChannel | null = null;
const listeners = new Set<() => void>();

const hasWindow = (): boolean => typeof window !== 'undefined' && typeof window.location !== 'undefined';

function storage(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function readStored(): Issued | null {
  try {
    const raw = storage('session')?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Issued>) : null;
    return parsed && typeof parsed.token === 'string' && TOKEN_RE.test(parsed.token) ? { token: parsed.token, renewAfterMs: Number(parsed.renewAfterMs) || DEFAULT_RENEW_AFTER_MS } : null;
  } catch {
    return null;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function adopt(issued: Issued, tellPeers: boolean): void {
  token = issued.token;
  adoptedAt = Date.now();
  renewAfterMs = issued.renewAfterMs > 0 ? issued.renewAfterMs : DEFAULT_RENEW_AFTER_MS;
  used = true;
  lost = false;
  try {
    storage('session')?.setItem(STORAGE_KEY, JSON.stringify({ token, renewAfterMs }));
    storage('local')?.setItem(USED_MARKER_KEY, '1');
  } catch {
    // storage unavailable: memory only (a reload then needs a new boot code)
  }
  if (tellPeers) channel?.postMessage({ type: 'token', token, renewAfterMs } satisfies PeerMessage);
  scheduleRenew(renewAfterMs);
  notify();
}

function drop(): void {
  token = null;
  lost = used;
  try {
    storage('session')?.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored
  }
  if (renewTimer) clearTimeout(renewTimer);
  renewTimer = null;
  notify();
}

/** The session routes of the app's own API, or `null` when that API is on another origin: the code and the token never leave the page's origin. */
function sessionUrl(path = ''): string | null {
  const url = `${DEFAULT_API_URL}/local-ui/session${path}`;
  return isSameOrigin(url) ? url : null;
}

/** Removes the boot code from the address (before anything else can read it) and returns it. */
function takeBootCode(): string | null {
  const hash = window.location.hash;
  if (!hash.includes(`${LOCAL_UI_BOOT_FRAGMENT_KEY}=`)) return null;
  const params = new URLSearchParams(hash.slice(1));
  const code = params.get(LOCAL_UI_BOOT_FRAGMENT_KEY);
  params.delete(LOCAL_UI_BOOT_FRAGMENT_KEY);
  const rest = params.toString();
  try {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`);
  } catch {
    window.location.hash = rest;
  }
  return code && CODE_RE.test(code) ? code : null;
}

async function post(path: string, init: { body?: string; token?: string }): Promise<Response> {
  const url = sessionUrl(path);
  if (!url) return new Response(null, { status: 404 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (init.token) headers[LOCAL_UI_SESSION_HEADER] = init.token;
    return await fetch(url, { method: 'POST', headers, body: init.body ?? '{}', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function issuedOf(body: unknown): Issued | null {
  const value = body as Partial<Issued> | null;
  return value && typeof value.token === 'string' && TOKEN_RE.test(value.token) ? { token: value.token, renewAfterMs: Number(value.renewAfterMs) || DEFAULT_RENEW_AFTER_MS } : null;
}

async function exchange(code: string): Promise<void> {
  used = true;
  for (let attempt = 1; attempt <= EXCHANGE_ATTEMPTS; attempt += 1) {
    try {
      const response = await post('', { body: JSON.stringify({ code }) });
      const issued = response.ok ? issuedOf(await response.json()) : null;
      if (issued) return adopt(issued, true);
      if (response.status === 401 || response.status === 404) break; // refused (already used, wrong code): retrying cannot help
    } catch {
      // network error or timeout: the code is still unused, try again
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  drop();
}

async function renew(): Promise<void> {
  const current = token;
  if (!current) return;
  try {
    const response = await post('/renew', { token: current });
    const issued = response.ok ? issuedOf(await response.json()) : null;
    if (issued) return adopt(issued, true);
    // Another tab may have rotated it first: keep the newer one it told us about.
    if (response.status === 401 && token === current) return drop();
  } catch {
    // network error: the token still lives for hours; try again soon
  }
  if (token === current) scheduleRenew(RETRY_RENEW_MS);
}

function scheduleRenew(delayMs: number): void {
  if (renewTimer) clearTimeout(renewTimer);
  // A little jitter so the tabs of one origin do not all rotate at once.
  renewTimer = setTimeout(() => void renew(), delayMs + Math.floor(Math.random() * 15_000));
}

function askPeers(): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      listeners.delete(onToken);
      resolve();
    };
    const onToken = (): void => {
      if (token) finish();
    };
    const timer = setTimeout(finish, ASK_PEERS_MS);
    listeners.add(onToken);
    channel?.postMessage({ type: 'ask' } satisfies PeerMessage);
  });
}

function onPeerMessage(event: MessageEvent<PeerMessage>): void {
  const message = event.data;
  if (message?.type === 'ask' && token) channel?.postMessage({ type: 'token', token, renewAfterMs } satisfies PeerMessage);
  else if (message?.type === 'token' && typeof message.token === 'string' && TOKEN_RE.test(message.token) && message.token !== token) {
    adopt({ token: message.token, renewAfterMs: message.renewAfterMs }, false);
  }
}

/** Starts the session of this page (called once, when this module loads in a browser). Exported for the tests. */
export function startLocalUiSession(): void {
  if (!hasWindow()) return;
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = onPeerMessage;
  }
  const code = takeBootCode();
  const stored = readStored();
  if (code) {
    pending = exchange(code).finally(() => (pending = null));
  } else if (stored) {
    adopt(stored, false);
  } else if (storage('local')?.getItem(USED_MARKER_KEY) === '1' && channel) {
    // A new tab of an origin that used a session: another tab may hand it over (never blocks more than ASK_PEERS_MS).
    used = true;
    pending = askPeers().finally(() => {
      pending = null;
      if (!token) drop();
    });
  }
  // Timers are throttled in a hidden page or a sleeping machine: back in view, a token past its renewal time is renewed at once.
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible' && token && !pending && Date.now() - adoptedAt >= renewAfterMs) void renew();
  });
}

/** Resolves once the boot exchange (or the hand-over from another tab) is over: wait for it before sending a request. */
export function whenLocalUiSessionReady(): Promise<void> {
  return pending ?? Promise.resolve();
}

function isSameOrigin(url: string | undefined, base?: string): boolean {
  if (!hasWindow()) return false;
  try {
    const resolvedBase = base ? new URL(base, window.location.href).href : window.location.href;
    return new URL(url ?? '', resolvedBase).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** `{ 'X-Local-Session': <token> }` for a same-origin `url` while a session is held, `{}` otherwise (any other origin, no session). */
export function localUiSessionHeaders(url?: string, base?: string): Record<string, string> {
  return token && isSameOrigin(url, base) ? { [LOCAL_UI_SESSION_HEADER]: token } : {};
}

/** `unused` (the app does not use it), `active`, or `lost` (the session expired or was refused: the window must be reopened). */
export function localUiSessionState(): LocalUiSessionState {
  if (token) return 'active';
  return lost ? 'lost' : 'unused';
}

/** Called on every change of {@link localUiSessionState}. Returns the unsubscribe function. */
export function onLocalUiSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test helper: forgets everything (memory, timers, channel). */
export function resetLocalUiSessionForTests(): void {
  if (renewTimer) clearTimeout(renewTimer);
  channel?.close();
  token = null;
  adoptedAt = 0;
  renewAfterMs = DEFAULT_RENEW_AFTER_MS;
  used = false;
  lost = false;
  pending = null;
  renewTimer = null;
  channel = null;
  listeners.clear();
}

// Every axios request (HttpService and the direct calls of the modules) waits for the boot exchange and carries the token on the same origin.
// `interceptors` is absent when a spec mocks axios as a bare function.
axios.interceptors?.request.use(async (config) => {
  await whenLocalUiSessionReady();
  const headers = localUiSessionHeaders(config.url, config.baseURL);
  for (const [name, value] of Object.entries(headers)) config.headers.set(name, value);
  return config;
});

startLocalUiSession();
