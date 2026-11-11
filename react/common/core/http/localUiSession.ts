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
 * Inert unless the page was opened with a boot code (`#vx-local-ui=<code>`, the desktop shell does it) or its tab already holds a session:
 * then
 *  - the code is removed from the address at once, then exchanged (`POST <api>/local-ui/session`) for a session token; every HTTP call waits
 *    for that exchange;
 *  - the token goes on every SAME-ORIGIN request as `X-Local-Session` (the axios interceptor installed here, `HttpService` streams,
 *    `localUiSessionHeaders()` for a hand-made `fetch`); never on another origin's request;
 *  - it is kept in memory and `sessionStorage` (per origin and per tab, so per port; a reload keeps it; never `localStorage` nor a cookie)
 *    and rotated every `renewAfterMs` the back sent. It is NEVER handed to another document (no `BroadcastChannel`, no `postMessage`): any
 *    page of the same origin could ask for it, or push one of its own. One window: the desktop's. Another tab needs a new boot code.
 */

import axios from 'axios';
import { DEFAULT_API_URL } from './apiBase';

export const LOCAL_UI_SESSION_HEADER = 'X-Local-Session';
/** Fragment key of the boot code (the desktop shell's `environment.rs` `UI_BOOT_FRAGMENT_KEY`). */
export const LOCAL_UI_BOOT_FRAGMENT_KEY = 'vx-local-ui';

const STORAGE_KEY = 'vx.localUi.session';
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

export type LocalUiSessionState = 'unused' | 'active' | 'lost';

let token: string | null = null;
/** When this page got its current token (`Date.now()`): a page woken from a long pause renews at once. */
let adoptedAt = 0;
let renewAfterMs = DEFAULT_RENEW_AFTER_MS;
let used = false;
let lost = false;
let pending: Promise<void> | null = null;
let renewTimer: ReturnType<typeof setTimeout> | null = null;
/** The renewal in flight: the timer and the return to view never send the same token twice (the back answers 409 to a second one). */
let renewing: Promise<void> | null = null;
const listeners = new Set<() => void>();

const hasWindow = (): boolean => typeof window !== 'undefined' && typeof window.location !== 'undefined';

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readStored(): Issued | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Issued>) : null;
    return parsed && typeof parsed.token === 'string' && TOKEN_RE.test(parsed.token) ? { token: parsed.token, renewAfterMs: Number(parsed.renewAfterMs) || DEFAULT_RENEW_AFTER_MS } : null;
  } catch {
    return null;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function adopt(issued: Issued): void {
  token = issued.token;
  adoptedAt = Date.now();
  renewAfterMs = issued.renewAfterMs > 0 ? issued.renewAfterMs : DEFAULT_RENEW_AFTER_MS;
  used = true;
  lost = false;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ token, renewAfterMs }));
  } catch {
    // storage unavailable: memory only (a reload then needs a new boot code)
  }
  scheduleRenew(renewAfterMs);
  notify();
}

function drop(): void {
  token = null;
  lost = used;
  try {
    storage()?.removeItem(STORAGE_KEY);
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
      if (issued) return adopt(issued);
      if (response.status === 401 || response.status === 404) break; // refused (already used, wrong code): retrying cannot help
    } catch {
      // network error or timeout: the code is still unused, try again
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  drop();
}

async function renewOnce(current: string): Promise<void> {
  try {
    const response = await post('/renew', { token: current });
    const issued = response.ok ? issuedOf(await response.json()) : null;
    if (issued) return adopt(issued);
    // 401: expired or refused; 409: someone else renewed this token first (it holds the chain now). Either way the page must be reopened.
    if (response.status === 401 || response.status === 409) return drop();
  } catch {
    // network error: the token still lives for hours; try again soon
  }
  if (token === current) scheduleRenew(RETRY_RENEW_MS);
}

function renew(): Promise<void> {
  const current = token;
  if (!current) return Promise.resolve();
  renewing ??= renewOnce(current).finally(() => (renewing = null));
  return renewing;
}

function scheduleRenew(delayMs: number): void {
  if (renewTimer) clearTimeout(renewTimer);
  renewTimer = setTimeout(() => void renew(), delayMs);
}

/** Starts the session of this page (called once, when this module loads in a browser). Exported for the tests. */
export function startLocalUiSession(): void {
  if (!hasWindow()) return;
  const code = takeBootCode();
  const stored = readStored();
  if (code) {
    pending = exchange(code).finally(() => (pending = null));
  } else if (stored) {
    adopt(stored);
  }
  // Timers are throttled in a hidden page or a sleeping machine: back in view, a token past its renewal time is renewed at once.
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible' && token && !pending && Date.now() - adoptedAt >= renewAfterMs) void renew();
  });
}

/** Resolves once the boot exchange is over: wait for it before sending a request. */
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

/** Test helper: forgets everything (memory, timers). */
export function resetLocalUiSessionForTests(): void {
  if (renewTimer) clearTimeout(renewTimer);
  token = null;
  adoptedAt = 0;
  renewAfterMs = DEFAULT_RENEW_AFTER_MS;
  used = false;
  lost = false;
  pending = null;
  renewTimer = null;
  renewing = null;
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
