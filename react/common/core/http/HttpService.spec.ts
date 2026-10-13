/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HttpResult } from './HttpResult';

// Bypass the real transport-encryption handshake (session negotiation, AES-GCM) — this
// spec is only about HttpService's in-flight dedup bookkeeping, not CryptService (which
// has its own spec). The mock calls the request factory immediately with a null
// sessionId, exactly like `skipTransport: true` would.
vi.mock('../../services/CryptService', () => ({
  cryptService: {
    wrapRequest: vi.fn(async (factory: (sessionId: string | null) => unknown) => factory(null)),
    getTransportCapabilityHeaders: () => ({}),
  },
}));

// axios itself is mocked so each test controls exactly when/how a "network" call
// resolves, and can count how many actually went out.
vi.mock('axios', () => ({ default: vi.fn() }));

import axios from 'axios';
import { httpService, toUploadProgress } from './HttpService';

const mockedAxios = axios as unknown as ReturnType<typeof vi.fn>;

function fakeSuccess(data: unknown, status = 200) {
  return { status, data, config: {}, headers: {}, statusText: 'OK' };
}

function fake401() {
  return { response: { status: 401 }, isAxiosError: true, message: 'Unauthorized', config: {} };
}

function fakeMaintenance503() {
  return {
    response: { status: 503, data: { maintenance: true } },
    isAxiosError: true,
    message: 'Service Unavailable',
    config: {},
  };
}

function fakePlain503() {
  return {
    response: { status: 503, data: { message: 'Something else failed' } },
    isAxiosError: true,
    message: 'Service Unavailable',
    config: {},
  };
}

/** Adapts the callback-based `HttpResult` into a Promise for `await` in tests. */
function toPromise<T = unknown>(result: HttpResult): Promise<T> {
  return new Promise((resolve, reject) => {
    result
      .then((d: unknown) => resolve(d as T))
      .fail((e: unknown) => reject(e))
      .error((e: unknown) => reject(e))
      .notAuthorized((e: unknown) => reject(e));
  });
}

describe('HttpService — opt-in in-flight request dedup (PERFORMANCE_PLAN.md §6.3/§2.2 b)', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
  });

  it('does NOT dedupe by default — two concurrent identical GETs fire two requests', async () => {
    mockedAxios.mockImplementation(() => Promise.resolve(fakeSuccess({ v: 1 })));

    const p1 = toPromise(httpService.get('/series/mvrv'));
    const p2 = toPromise(httpService.get('/series/mvrv'));
    await Promise.all([p1, p2]);

    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it('never dedupes based on the verb alone — identical concurrent POSTs without the opt-in fire twice', async () => {
    mockedAxios.mockImplementation(() => Promise.resolve(fakeSuccess({ ok: true })));

    const body = { names: ['mvrv'], dateStart: '2020-01-01', dateEnd: '2020-01-31' };
    const p1 = toPromise(httpService.post('/indicatorvalues/seriebyday-batch', body));
    const p2 = toPromise(httpService.post('/indicatorvalues/seriebyday-batch', body));
    await Promise.all([p1, p2]);

    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it('dedupes two concurrent GETs sharing method+url+body when dedupe:true, and delivers the result to BOTH callers', async () => {
    mockedAxios.mockImplementation(() => Promise.resolve(fakeSuccess({ v: 42 })));

    const p1 = toPromise<{ v: number }>(httpService.get('/series/mvrv', { dedupe: true }));
    const p2 = toPromise<{ v: number }>(httpService.get('/series/mvrv', { dedupe: true }));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ v: 42 });
    expect(r2).toEqual({ v: 42 });
  });

  it('dedupes a read-shaped POST (e.g. seriebyday-batch) with dedupe:true, same key = method+url+serialized body', async () => {
    mockedAxios.mockImplementation(() => Promise.resolve(fakeSuccess({ mvrv: [1, 2, 3] })));

    const body = { names: ['mvrv'], dateStart: '2020-01-01', dateEnd: '2020-01-31' };
    const p1 = toPromise(httpService.post('/indicatorvalues/seriebyday-batch', body, { dedupe: true }));
    const p2 = toPromise(httpService.post('/indicatorvalues/seriebyday-batch', body, { dedupe: true }));
    await Promise.all([p1, p2]);

    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  it('does not share the in-flight entry across different bodies even with dedupe:true (different cache key)', async () => {
    mockedAxios.mockImplementation(() => Promise.resolve(fakeSuccess({ ok: true })));

    const p1 = toPromise(httpService.post('/indicatorvalues/seriebyday-batch', { names: ['mvrv'] }, { dedupe: true }));
    const p2 = toPromise(httpService.post('/indicatorvalues/seriebyday-batch', { names: ['nupl'] }, { dedupe: true }));
    await Promise.all([p1, p2]);

    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry on success — a later call (after resolution) issues a fresh request', async () => {
    mockedAxios.mockImplementation(() => Promise.resolve(fakeSuccess({ v: 1 })));

    await toPromise(httpService.get('/series/mvrv', { dedupe: true }));
    await toPromise(httpService.get('/series/mvrv', { dedupe: true }));

    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry on failure — a later call is not stuck on the failed attempt', async () => {
    mockedAxios
      .mockImplementationOnce(() => Promise.reject(fake401()))
      .mockImplementation(() => Promise.resolve(fakeSuccess({ v: 7 })));

    await expect(toPromise(httpService.get('/series/mvrv', { dedupe: true }))).rejects.toBeTruthy();
    const result = await toPromise<{ v: number }>(httpService.get('/series/mvrv', { dedupe: true }));

    expect(mockedAxios).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ v: 7 });
  });

  it('a dedup\'d request that self-heals via the 401 token refresh delivers the RETRIED result to every concurrent caller, not the failed attempt', async () => {
    let calls = 0;
    mockedAxios.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(fake401());
      return Promise.resolve(fakeSuccess({ v: 'retried' }));
    });
    const refresher = vi.fn(async () => true);
    httpService.setTokenRefresher(refresher, () => true);

    const p1 = toPromise<{ v: string }>(httpService.get('/series/mvrv', { dedupe: true }));
    const p2 = toPromise<{ v: string }>(httpService.get('/series/mvrv', { dedupe: true }));
    const [r1, r2] = await Promise.all([p1, p2]);

    // One failed attempt + one retried attempt — NOT one pair per caller (4 calls) and
    // NOT a caller left hanging on the 401.
    expect(mockedAxios).toHaveBeenCalledTimes(2);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ v: 'retried' });
    expect(r2).toEqual({ v: 'retried' });
  });
});

describe('HttpService — global maintenance detection (back-lb maintenance.flag marker)', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    httpService.setGlobalMaintenanceHandler(() => {});
  });

  it('fires the handler with true on a 503 carrying the maintenance marker, AND still calls the per-request error callback', async () => {
    mockedAxios.mockImplementation(() => Promise.reject(fakeMaintenance503()));
    const handler = vi.fn();
    httpService.setGlobalMaintenanceHandler(handler);

    await expect(toPromise(httpService.get('/series/mvrv'))).rejects.toBeTruthy();

    expect(handler).toHaveBeenCalledWith(true);
  });

  it('does NOT fire on a plain 503 without the maintenance marker', async () => {
    mockedAxios.mockImplementation(() => Promise.reject(fakePlain503()));
    const handler = vi.fn();
    httpService.setGlobalMaintenanceHandler(handler);

    await expect(toPromise(httpService.get('/series/mvrv'))).rejects.toBeTruthy();

    expect(handler).not.toHaveBeenCalled();
  });

  it('fires the handler with false as soon as a request succeeds again', async () => {
    mockedAxios.mockImplementation(() => Promise.resolve(fakeSuccess({ v: 1 })));
    const handler = vi.fn();
    httpService.setGlobalMaintenanceHandler(handler);

    await toPromise(httpService.get('/series/mvrv'));

    expect(handler).toHaveBeenCalledWith(false);
  });
});

describe('HttpService — streamGet (SSE, GET, no transport encryption)', () => {
  const okResponse = () => ({ ok: true, status: 200, body: {} as ReadableStream<Uint8Array> });
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    (mockedAxios as unknown as { defaults: unknown }).defaults = {
      headers: { common: { Authorization: 'Bearer user-token' } },
    };
  });

  it('sends a GET with the in-memory Bearer and caller headers', async () => {
    httpService.setTokenRefresher(async () => true, () => true, () => false);
    fetchMock.mockResolvedValue(okResponse());
    const signal = new AbortController().signal;

    await httpService.streamGet('/api/v1/events/stream?topics=a.b', { signal, headers: { 'Last-Event-ID': '9' } });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/events/stream?topics=a.b');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.signal).toBe(signal);
    expect(init.headers).toEqual({ 'Last-Event-ID': '9', Authorization: 'Bearer user-token' });
  });

  it('refreshes pre-emptively when the token is stale, and notifies refresh listeners', async () => {
    const refresher = vi.fn(async () => true);
    httpService.setTokenRefresher(refresher, () => true, () => true);
    const listener = vi.fn();
    const off = httpService.onTokenRefreshed(listener);
    fetchMock.mockResolvedValue(okResponse());

    await httpService.streamGet('/api/v1/events/stream?topics=a.b');

    expect(refresher).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('retries once on 401 after a refresh, then throws a StreamHttpError with the status', async () => {
    const refresher = vi.fn(async () => true);
    httpService.setTokenRefresher(refresher, () => true, () => false);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 }).mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(httpService.streamGet('/api/v1/events/stream?topics=a.b')).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it('uses a registered API token instead of the user token and never self-heals', async () => {
    const refresher = vi.fn(async () => true);
    httpService.setTokenRefresher(refresher, () => true, () => true);
    httpService.registerApiToken('https://remote.example/', 'remote-token');
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    await expect(httpService.streamGet('https://remote.example/api/v1/events/stream')).rejects.toMatchObject({
      status: 401,
    });
    expect(refresher).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Bearer remote-token');
  });
});

describe('toUploadProgress', () => {
  it('computes a rounded percentage from loaded/total', () => {
    expect(toUploadProgress({ loaded: 1, total: 3 })).toEqual({ loaded: 1, total: 3, percent: 33 });
  });

  it('clamps above 100 and reports null while the total is unknown', () => {
    expect(toUploadProgress({ loaded: 12, total: 10 }).percent).toBe(100);
    expect(toUploadProgress({ loaded: 5 })).toEqual({ loaded: 5, total: null, percent: null });
    expect(toUploadProgress({ loaded: 5, total: 0 }).percent).toBeNull();
  });
});

describe('HttpService.upload', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    httpService.setTokenRefresher(async () => true, () => false, () => false);
  });

  it('posts the FormData with per-request headers, the abort signal and no JSON Content-Type', async () => {
    mockedAxios.mockResolvedValue(fakeSuccess({ id: 7 }));
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.txt');
    const { signal } = new AbortController();

    const result = await toPromise<{ id: number }>(
      httpService.upload('/api/files', form, { headers: { 'x-company-id': '3' }, signal }),
    );

    expect(result).toEqual({ id: 7 });
    const config = mockedAxios.mock.calls[0][0];
    expect(config.method).toBe('post');
    expect(config.data).toBe(form);
    expect(config.signal).toBe(signal);
    expect(config.headers).toEqual({ 'x-company-id': '3' });
  });

  it('forwards real progress events through onProgress', async () => {
    const onProgress = vi.fn();
    mockedAxios.mockImplementation(async (config: { onUploadProgress: (e: object) => void }) => {
      config.onUploadProgress({ loaded: 50, total: 200 });
      return fakeSuccess({});
    });

    await toPromise(httpService.upload('/api/files', new FormData(), { onProgress }));

    expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: 200, percent: 25 });
  });

  it('uses the registered API token for its prefix, but lets an explicit Authorization header win', async () => {
    mockedAxios.mockResolvedValue(fakeSuccess({}));
    httpService.registerApiToken('https://remote.example/', 'remote-token');

    await toPromise(httpService.upload('https://remote.example/up', new FormData()));
    await toPromise(
      httpService.upload('https://remote.example/up', new FormData(), { headers: { Authorization: 'Bearer mine' } }),
    );

    expect(mockedAxios.mock.calls[0][0].headers.Authorization).toBe('Bearer remote-token');
    expect(mockedAxios.mock.calls[1][0].headers.Authorization).toBe('Bearer mine');
  });

  it('routes a failure to the error callback', async () => {
    mockedAxios.mockRejectedValue({ response: { status: 500, data: { message: 'boom' } }, message: 'x', config: {} });

    await expect(toPromise(httpService.upload('/api/files', new FormData()))).rejects.toMatchObject({
      message: 'boom',
      statusCode: 500,
    });
  });
});
