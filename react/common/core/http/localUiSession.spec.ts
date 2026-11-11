/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const axiosInterceptors = vi.hoisted(() => ({ use: vi.fn() }));
vi.mock('axios', () => ({ default: { interceptors: { request: axiosInterceptors } } }));
// The app's API base as a desktop build has it (relative: served by the back); the project's own VITE_API_URL must not leak into the spec.
const apiBase = vi.hoisted(() => ({ DEFAULT_API_URL: '/api/v1' }));
vi.mock('./apiBase', () => apiBase);

type Module = typeof import('./localUiSession');

// Fake values built at run time (never a real secret): a boot code is 64 hex characters, a token 43 base64url characters.
const hex = (seed: string): string => seed.repeat(64).slice(0, 64);
const tokenOf = (seed: string): string => seed.repeat(43).slice(0, 43);

class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

interface Page {
  location: { href: string; origin: string; hash: string; pathname: string; search: string };
  replaceState: ReturnType<typeof vi.fn>;
  sessionStorage: MemoryStorage;
  localStorage: MemoryStorage;
  fetch: ReturnType<typeof vi.fn>;
}

function page(hash = '', storages?: { sessionStorage?: MemoryStorage; localStorage?: MemoryStorage }): Page {
  const location = { href: `http://127.0.0.1:4321/projects${hash}`, origin: 'http://127.0.0.1:4321', hash, pathname: '/projects', search: '' };
  const replaceState = vi.fn((_state: unknown, _title: string, url: string) => {
    const at = url.indexOf('#');
    location.hash = at < 0 ? '' : url.slice(at);
    location.href = `http://127.0.0.1:4321${url}`;
  });
  const sessionStorage = storages?.sessionStorage ?? new MemoryStorage();
  const localStorage = storages?.localStorage ?? new MemoryStorage();
  const fetch = vi.fn();
  vi.stubGlobal('window', { location, history: { state: null, replaceState }, sessionStorage, localStorage });
  vi.stubGlobal('document', { addEventListener: vi.fn(), visibilityState: 'visible' });
  vi.stubGlobal('fetch', fetch);
  return { location, replaceState, sessionStorage, localStorage, fetch };
}

function answer(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function load(): Promise<Module> {
  vi.resetModules();
  return import('./localUiSession');
}

describe('localUiSession (page side of the interface session)', () => {
  let mod: Module | null = null;
  beforeEach(() => {
    axiosInterceptors.use.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    apiBase.DEFAULT_API_URL = '/api/v1';
    mod?.resetLocalUiSessionForTests();
    mod = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is inert without a boot code nor a session: no request, no header, nothing to wait for', async () => {
    const p = page();
    mod = await load();
    await mod.whenLocalUiSessionReady();
    expect(p.fetch).not.toHaveBeenCalled();
    expect(mod.localUiSessionHeaders('/api/v1/agenthub/projects')).toEqual({});
    expect(mod.localUiSessionState()).toBe('unused');
  });

  it('removes the boot code from the address at once, exchanges it, then sends the token on same-origin requests only', async () => {
    const code = hex('a1');
    const p = page(`#other=1&vx-local-ui=${code}`);
    p.fetch.mockResolvedValueOnce(answer(200, { token: tokenOf('t'), ttlMs: 1000, renewAfterMs: 600_000 }));
    mod = await load();
    // Synchronously, before any request: the code is gone from the address, the other fragment parameter stays.
    expect(p.replaceState).toHaveBeenCalledTimes(1);
    expect(p.location.hash).toBe('#other=1');
    await mod.whenLocalUiSessionReady();
    const [url, init] = p.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/local-ui/session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ code });
    expect(mod.localUiSessionHeaders('/api/v1/agenthub/projects')).toEqual({ 'X-Local-Session': tokenOf('t') });
    expect(mod.localUiSessionHeaders('http://127.0.0.1:4321/api/v1/x')).toEqual({ 'X-Local-Session': tokenOf('t') });
    expect(mod.localUiSessionHeaders('http://127.0.0.1:5173/api/v1/x')).toEqual({});
    expect(mod.localUiSessionHeaders('https://hub.example.com/api/v1/x')).toEqual({});
    expect(mod.localUiSessionState()).toBe('active');
    // Kept for a reload of this tab only (sessionStorage), never in localStorage (just a non-secret marker there).
    expect(p.sessionStorage.getItem('vx.localUi.session')).toContain(tokenOf('t'));
    expect(p.localStorage.getItem('vx.localUi.used')).toBe('1');
  });

  it('a refused code leaves the page without session (lost), with no second try', async () => {
    const p = page(`#vx-local-ui=${hex('b2')}`);
    p.fetch.mockResolvedValue(answer(401));
    mod = await load();
    await mod.whenLocalUiSessionReady();
    expect(p.fetch).toHaveBeenCalledTimes(1);
    expect(mod.localUiSessionHeaders('/api/v1/x')).toEqual({});
    expect(mod.localUiSessionState()).toBe('lost');
  });

  it('retries the exchange after a network error (the code is still unused)', async () => {
    const p = page(`#vx-local-ui=${hex('c3')}`);
    p.fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(answer(200, { token: tokenOf('u'), renewAfterMs: 600_000 }));
    mod = await load();
    await mod.whenLocalUiSessionReady();
    expect(p.fetch).toHaveBeenCalledTimes(2);
    expect(mod.localUiSessionState()).toBe('active');
  });

  it('never sends the code to an API on another origin', async () => {
    apiBase.DEFAULT_API_URL = 'https://hub.example.com/api/v1';
    const p = page(`#vx-local-ui=${hex('e5')}`);
    mod = await load();
    await mod.whenLocalUiSessionReady();
    expect(p.location.hash).toBe('');
    expect(p.fetch).not.toHaveBeenCalled();
    expect(mod.localUiSessionState()).toBe('lost');
  });

  it('ignores a malformed code in the fragment (and still removes it)', async () => {
    const p = page('#vx-local-ui=not-a-code');
    mod = await load();
    await mod.whenLocalUiSessionReady();
    expect(p.location.hash).toBe('');
    expect(p.fetch).not.toHaveBeenCalled();
  });

  it('a reload keeps the session of the tab (sessionStorage) without any request', async () => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem('vx.localUi.session', JSON.stringify({ token: tokenOf('r'), renewAfterMs: 600_000 }));
    const p = page('', { sessionStorage });
    mod = await load();
    expect(p.fetch).not.toHaveBeenCalled();
    expect(mod.localUiSessionHeaders('/api/v1/x')).toEqual({ 'X-Local-Session': tokenOf('r') });
  });

  it('rotates the token when the back says so; a refused renewal loses the session', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter: the renewals fire exactly every renewAfterMs
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem('vx.localUi.session', JSON.stringify({ token: tokenOf('o'), renewAfterMs: 1_000 }));
    const p = page('', { sessionStorage });
    p.fetch.mockResolvedValueOnce(answer(200, { token: tokenOf('n'), renewAfterMs: 1_000 })).mockResolvedValueOnce(answer(401));
    mod = await load();
    await vi.advanceTimersByTimeAsync(1_000);
    const [url, init] = p.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/local-ui/session/renew');
    expect((init.headers as Record<string, string>)['X-Local-Session']).toBe(tokenOf('o'));
    expect(mod.localUiSessionHeaders('/api/v1/x')).toEqual({ 'X-Local-Session': tokenOf('n') });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mod.localUiSessionState()).toBe('lost');
    expect(sessionStorage.getItem('vx.localUi.session')).toBeNull();
  });

  it('the axios interceptor waits for the exchange, then adds the header to same-origin requests only', async () => {
    const p = page(`#vx-local-ui=${hex('d4')}`);
    let release: (r: Response) => void = () => undefined;
    p.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));
    mod = await load();
    const interceptor = axiosInterceptors.use.mock.calls[0]![0] as (config: { url?: string; baseURL?: string; headers: Map<string, string> }) => Promise<unknown>;
    const headers = new Map<string, string>();
    const sent = interceptor({ url: '/api/v1/agenthub/projects', headers });
    await Promise.resolve();
    expect(headers.size).toBe(0);
    release(answer(200, { token: tokenOf('x'), renewAfterMs: 600_000 }));
    await sent;
    expect(headers.get('X-Local-Session')).toBe(tokenOf('x'));
    const foreign = new Map<string, string>();
    await interceptor({ url: 'https://api.example.com/v1/data', headers: foreign });
    expect(foreign.size).toBe(0);
  });

  it('a new tab of an origin that used a session gets it from another tab', async () => {
    const localStorage = new MemoryStorage();
    localStorage.setItem('vx.localUi.used', '1');
    const peer = new BroadcastChannel('vx-local-ui');
    peer.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data.type === 'ask') peer.postMessage({ type: 'token', token: tokenOf('p'), renewAfterMs: 600_000 });
    };
    try {
      const p = page('', { localStorage });
      mod = await load();
      await mod.whenLocalUiSessionReady();
      expect(p.fetch).not.toHaveBeenCalled();
      expect(mod.localUiSessionHeaders('/api/v1/x')).toEqual({ 'X-Local-Session': tokenOf('p') });
    } finally {
      peer.close();
    }
  });

  it('a new tab with no other tab to ask is told the session is lost (the window must be reopened)', async () => {
    const localStorage = new MemoryStorage();
    localStorage.setItem('vx.localUi.used', '1');
    page('', { localStorage });
    mod = await load();
    await mod.whenLocalUiSessionReady();
    expect(mod.localUiSessionState()).toBe('lost');
  });
});
