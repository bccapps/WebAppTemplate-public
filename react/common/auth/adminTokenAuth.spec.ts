/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Cb = () => void;
const httpState = { ok: true };

vi.mock('../core/http/HttpService', () => ({
  httpService: {
    get: vi.fn(() => {
      const chain: Record<string, (cb: Cb) => unknown> = {};
      const run = (cb: Cb, fire: boolean) => {
        if (fire) queueMicrotask(cb);
        return chain;
      };
      chain.then = (cb) => run(cb, httpState.ok);
      chain.fail = (cb) => run(cb, !httpState.ok);
      chain.error = () => chain;
      chain.notAuthorized = () => chain;
      return chain;
    }),
  },
}));
vi.mock('../services/ConfigurationService', () => ({
  configurationService: { getApiUrl: (m?: string) => `/api/v1#${m}` },
}));

import axios from 'axios';
import { httpService } from '../core/http/HttpService';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string) { return this.data.has(k) ? (this.data.get(k) as string) : null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

const bearer = () => axios.defaults.headers.common['Authorization'];

async function load() {
  vi.resetModules();
  return (await import('./adminTokenAuth')).adminTokenAuth;
}

describe('adminTokenAuth', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    httpState.ok = true;
    delete axios.defaults.headers.common['Authorization'];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is anonymous and unauthenticated by default', async () => {
    const auth = await load();
    expect(auth.mode).toBe('anonymous');
    expect(auth.isAuth()).toBe(false);
    expect(auth.get()).toBeNull();
  });

  it('login ok: probes admin-session, stores token, sets bearer, emits user', async () => {
    const auth = await load();
    const { appSession } = await import('../core/session/AppSession');
    const listener = vi.fn();
    appSession.addEventListener('user', listener);
    await expect(auth.login('secret')).resolves.toBe(true);
    expect(httpService.get).toHaveBeenCalledWith('/api/v1#common/admin-session');
    expect(sessionStorage.getItem('vx_admin_token')).toBe('secret');
    expect(bearer()).toBe('Bearer secret');
    expect(auth.isAdmin()).toBe(true);
    expect(auth.get()).toEqual({ id: 0, admin: true });
    expect(listener).toHaveBeenCalled();
  });

  it('login ko: removes header, stores nothing', async () => {
    const auth = await load();
    httpState.ok = false;
    await expect(auth.login('bad')).resolves.toBe(false);
    expect(bearer()).toBeUndefined();
    expect(sessionStorage.getItem('vx_admin_token')).toBeNull();
    expect(auth.isAuth()).toBe(false);
  });

  it('restore re-applies a stored token at module load without network call', async () => {
    sessionStorage.setItem('vx_admin_token', 'kept');
    const callsBefore = (httpService.get as ReturnType<typeof vi.fn>).mock.calls.length;
    const auth = await load();
    expect(bearer()).toBe('Bearer kept');
    expect(auth.isAdmin()).toBe(true);
    expect((httpService.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('clear removes storage and header', async () => {
    const auth = await load();
    await auth.login('secret');
    auth.clear();
    expect(sessionStorage.getItem('vx_admin_token')).toBeNull();
    expect(bearer()).toBeUndefined();
    expect(auth.isAuth()).toBe(false);
  });

  it('falls back to memory when sessionStorage is unavailable', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    const auth = await load();
    await expect(auth.login('mem')).resolves.toBe(true);
    expect(auth.isAdmin()).toBe(true);
    auth.clear();
    expect(auth.isAdmin()).toBe(false);
  });
});
