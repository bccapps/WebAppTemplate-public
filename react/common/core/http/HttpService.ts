/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import axios from 'axios';
import type { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { HttpResult } from './HttpResult';
import { cryptService } from '../../services/CryptService';
import { TRANSPORT_SESSION_HEADER } from '../../constants/crypt.constants';

type HttpRequestOptions = {
  skipTransport?: boolean;
  /** Set to true for requests that must send or receive cookies (cross-origin cookie flows). */
  withCredentials?: boolean;
  /**
   * Opt-in in-flight request deduplication (PERFORMANCE_PLAN.md §6.3/§2.2 b): when a
   * second call with the same method + URL + serialized body is made while an identical
   * request is still pending, it reuses the same in-flight execution instead of firing a
   * second one — each caller still gets its own `HttpResult` with its own callbacks fired
   * (native Promises fan out to every attached `.then()`/`.catch()`, so no extra plumbing
   * is needed for that). Cleared on settlement, success or failure alike, so a follow-up
   * call after the shared request resolves always starts a fresh request.
   *
   * ⚠️ Deliberately NOT inferred from the HTTP verb: a `POST` can be a read (e.g. this
   * app's `seriebyday-batch`) or a write, and `HttpService` cannot tell the difference.
   * Never pass `dedupe: true` for a request that has side effects (creates/updates/
   * deletes) — two callers awaiting it would still only trigger it once.
   */
  dedupe?: boolean;
};

class HttpService {
  private apiTokens: { prefix: string; token: string }[] = [];
  private globalUnauthorizedHandler: (() => void) | null = null;
  /** Called with `true` when a response carries the maintenance marker (503 + `{maintenance:
   *  true}` body — see `setGlobalMaintenanceHandler`), and with `false` on the next response
   *  that succeeds normally. Lets the app show a full-screen "back soon" state without every
   *  call site special-casing this one response shape. */
  private globalMaintenanceHandler: ((active: boolean) => void) | null = null;
  /** Refreshes the user access token (rotates the in-memory Bearer on axios defaults).
   *  Resolves true on success. Registered by the auth layer; null when unauthenticated. */
  private tokenRefresher: (() => Promise<boolean>) | null = null;
  /** Returns whether a user session is currently considered authenticated. Used to gate
   *  the reactive refresh and the global 401 handler without reading a (now removed)
   *  localStorage token — under cookie auth the access token lives in memory only. */
  private isAuthedProvider: (() => boolean) | null = null;
  /** Returns true when the in-memory access token is already expired (or within a small skew).
   *  Lets an authenticated request refresh PRE-EMPTIVELY instead of eating a guaranteed 401 +
   *  reactive retry — kills the per-poll 401 churn when the proactive refresh timer has drifted
   *  (background tab, sleep, network change). Null when unauthenticated. */
  private isTokenStaleProvider: (() => boolean) | null = null;
  /** In-flight request registry for `{ dedupe: true }` calls (PERFORMANCE_PLAN.md §6.3).
   *  Keyed by method+url+serialized body; cleared on settlement (success or failure). See
   *  `HttpRequestOptions.dedupe` for the contract. */
  private readonly inFlightRequests = new Map<string, Promise<AxiosResponse<any>>>();

  /**
   * Register a global handler called whenever a 401 response is received on an
   * authenticated request that has no per-request `.notAuthorized()` callback.
   * Typical use: force-disconnect the user and redirect to the app home page.
   */
  setGlobalUnauthorizedHandler(handler: () => void): void {
    this.globalUnauthorizedHandler = handler;
  }

  /**
   * Register a handler called with `true` as soon as any request hits the reverse-proxy's
   * maintenance mode (503 response with a `{ maintenance: true }` body — see the back-lb
   * nginx maintenance-flag toggle in `deploy-full.sh`), and with `false` the next time a
   * request succeeds normally. There is no dedicated "are we in maintenance" endpoint: the
   * marker rides on whatever request the app was already making, in-flight or not.
   */
  setGlobalMaintenanceHandler(handler: (active: boolean) => void): void {
    this.globalMaintenanceHandler = handler;
  }

  /**
   * Wire the auth layer so authenticated requests can self-heal on a 401: when the access
   * token has expired (clock drift, tab wake, network change), `refresher` silently rotates
   * it via the refresh cookie and the request is retried once. `isAuthed` reports whether a
   * user session exists, used to gate both the retry and the global unauthorized handler.
   * `isTokenStale` (optional) reports whether the in-memory access token is already expired, so
   * an authenticated request refreshes pre-emptively instead of provoking a guaranteed 401.
   */
  setTokenRefresher(
    refresher: () => Promise<boolean>,
    isAuthed: () => boolean,
    isTokenStale?: () => boolean,
  ): void {
    this.tokenRefresher = refresher;
    this.isAuthedProvider = isAuthed;
    this.isTokenStaleProvider = isTokenStale ?? null;
  }

  /** Auth endpoints must never trigger the reactive refresh (they ARE the refresh path,
   *  retrying them on 401 would recurse). */
  private isAuthEndpoint(url: string): boolean {
    return /\/users\/(refresh|auth|login|logout)/.test(url);
  }

  /**
   * Register a bearer token for all URLs matching a given prefix.
   * When a request URL starts with `prefix`, this token is used
   * instead of the user JWT from localStorage.
   */
  registerApiToken(urlPrefix: string, token: string): void {
    const existing = this.apiTokens.find((e) => e.prefix === urlPrefix);
    if (existing) {
      existing.token = token;
    } else {
      this.apiTokens.push({ prefix: urlPrefix, token });
    }
  }

  private getApiToken(url: string): string | undefined {
    for (const entry of this.apiTokens) {
      if (url.startsWith(entry.prefix)) return entry.token;
    }
    return undefined;
  }

  private summarizeData(data: any) {
    if (Array.isArray(data)) {
      return data.slice(0, 5);
    }
    if (data && typeof data === 'object') {
      return Object.fromEntries(Object.entries(data).slice(0, 5));
    }
    return data;
  }

  /**
   * get
   * @returns
   */
  get = (url: string, options?: HttpRequestOptions): HttpResult => {
    const promise = this.runRequestDeduped(
      {
        method: 'get',
        url,
        responseType: 'json',
      },
      options,
    );
    const httpResult: HttpResult = new HttpResult();
    promise
      .then((axiosResponse: AxiosResponse<any, any>) => {
        this.treatResponse(httpResult, axiosResponse);
      })
      .catch((axiosError: AxiosError) => {
        this.treatError(httpResult, axiosError);
      });
    return httpResult;
  };
  /**
   * gets
   * @param urls dict containing urls indexed by a key passed as a parameter to the url
   * @returns
   */
  gets = (urls: { [id: string]: string }, options?: HttpRequestOptions): HttpResult => {
    const promises = Object.entries(urls).map(([key, url]) =>
      this.runRequestDeduped(
        {
          method: 'get',
          url,
          responseType: 'json',
          params: { id: key },
        },
        options,
      ),
    );
    const httpResult: HttpResult = new HttpResult();
    Promise.all(promises)
      .then((axiosResponses: AxiosResponse<any, any>[]) => {
        this.treatResponses(httpResult, axiosResponses);
      })
      .catch((axiosError: AxiosError) => {
        this.treatError(httpResult, axiosError);
      });
    return httpResult;
  };
  /**
   * post
   * @param url
   * @param payload
   */
  post = (url: string, payload: any, options?: HttpRequestOptions): HttpResult => {
    const promise = this.runRequestDeduped(
      {
        method: 'post',
        url,
        data: payload,
        responseType: 'json',
      },
      options,
    );
    const httpResult: HttpResult = new HttpResult();
    promise
      .then((axiosResponse: AxiosResponse<any, any>) => {
        this.treatResponse(httpResult, axiosResponse);
      })
      .catch((axiosError: AxiosError) => {
        this.treatError(httpResult, axiosError);
      });
    return httpResult;
  };
  /**
   * put
   * @param url
   * @param payload
   * @returns
   */
  put = (url: string, payload: any, options?: HttpRequestOptions): HttpResult => {
    const promise = this.runRequestDeduped(
      {
        method: 'put',
        url,
        data: payload,
        responseType: 'json',
      },
      options,
    );
    const httpResult: HttpResult = new HttpResult();
    promise
      .then((axiosResponse: AxiosResponse<any, any>) => {
        this.treatResponse(httpResult, axiosResponse);
      })
      .catch((axiosError: AxiosError) => {
        this.treatError(httpResult, axiosError);
      });
    return httpResult;
  };

  patch = (url: string, payload: any, options?: HttpRequestOptions): HttpResult => {
    const promise = this.runRequestDeduped(
      {
        method: 'patch',
        url,
        data: payload,
        responseType: 'json',
      },
      options,
    );
    const httpResult: HttpResult = new HttpResult();
    promise
      .then((axiosResponse: AxiosResponse<any, any>) => {
        this.treatResponse(httpResult, axiosResponse);
      })
      .catch((axiosError: AxiosError) => {
        this.treatError(httpResult, axiosError);
      });
    return httpResult;
  };

  /**
   *
   * @param url
   * @returns
   */
  delete = (url: string, options?: HttpRequestOptions): HttpResult => {
    const promise = this.runRequestDeduped(
      {
        method: 'delete',
        url,
        responseType: 'json',
      },
      options,
    );
    const httpResult: HttpResult = new HttpResult();
    promise
      .then((axiosResponse: AxiosResponse<any, any>) => {
        this.treatResponse(httpResult, axiosResponse);
      })
      .catch((axiosError: AxiosError) => {
        this.treatError(httpResult, axiosError);
      });
    return httpResult;
  };
  /**
   * treat the axios response
   * @param httpResult
   * @param AxiosResponse
   */
  private treatResponse(httpResult: HttpResult, axiosResponse: AxiosResponse) {
    const url = axiosResponse.config?.url ?? '';
    const isRemote = this.getApiToken(url) !== undefined;
    if (isRemote) {
      console.log('[HttpService] Remote API response', {
        url,
        status: axiosResponse.status,
        contentType: axiosResponse.headers?.['content-type'],
        dataType: typeof axiosResponse.data,
        isArray: Array.isArray(axiosResponse.data),
        data: axiosResponse.data,
      });
    }
    if (axiosResponse.status >= 200 && axiosResponse.status < 300) {
      this.globalMaintenanceHandler?.(false);
      if (httpResult.thenCb) {
        httpResult.thenCb(axiosResponse.data);
      }
    }
  }
  /**
   * treat multiple axios response
   * @param httpResult
   * @param AxiosResponse[]
   */
  private treatResponses(
    httpResult: HttpResult,
    axiosResponses: AxiosResponse[]
  ) {
    if (httpResult.thenCb) {
      let globaldata = {};
      for (const axiosResponse of axiosResponses) {
        if (axiosResponse.status >= 200 && axiosResponse.status < 300) {
          //const req = axiosResponse;
          //console.log('Request: %o', req);
          console.log('[HttpService] Batch response payload', {
            url: axiosResponse.config?.url,
            id: axiosResponse.config?.params?.['id'],
            isArray: Array.isArray(axiosResponse.data),
            dataPreview: this.summarizeData(axiosResponse.data),
          });
          const id = axiosResponse.config.params['id'];
          const newdata: { [id: string]: any } = {};
          newdata[id] = axiosResponse.data;
          globaldata = { ...globaldata, ...newdata };
        }
      }
      httpResult.thenCb(globaldata);
    }
  }
  /**
   * treat the axios error
   * @param httpResult
   * @param AxiosError
   */
  private treatError(httpResult: HttpResult, axiosError: AxiosError) {
    if (axiosError == null) return;
    const url = axiosError.config?.url ?? '';
    if (this.getApiToken(url) !== undefined) {
      console.warn('[HttpService] Remote API error', {
        url,
        status: axiosError.response?.status,
        message: axiosError.message,
        data: axiosError.response?.data,
      });
    }
    // back-lb serves this for EVERY path (API calls included) while its maintenance flag
    // file is present — see deploy-full.sh's deploy_back_host(). Reported globally in
    // addition to the normal fail/error callback below, never instead of it: a caller
    // awaiting this specific request still needs its own callback to fire.
    if (axiosError?.response?.status === 503 && (axiosError.response?.data as any)?.maintenance === true) {
      this.globalMaintenanceHandler?.(true);
    }

    const payload = this.extractErrorPayload(axiosError);
    if (axiosError?.response?.status == 400 && httpResult.failCb) {
      httpResult.failCb(payload);
    } else if (axiosError?.response?.status == 401) {
      if (httpResult.notAuthorizedCb) {
        httpResult.notAuthorizedCb(payload);
      }
      // Always fire global handler when an authenticated user session hits a 401 that the
      // reactive refresh could not resolve (definitive expiry), regardless of per-request
      // callback. This ensures stale sessions are cleaned up and the app redirected.
      // NOTE: gate on the in-memory session (isAuthedProvider), NOT a localStorage token —
      // under cookie auth the access token lives in memory only and 'token' is always absent,
      // which previously left this handler permanently dead.
      const url = axiosError.config?.url ?? '';
      if (
        this.globalUnauthorizedHandler &&
        this.getApiToken(url) === undefined &&
        (this.isAuthedProvider == null || this.isAuthedProvider())
      ) {
        this.globalUnauthorizedHandler();
      }
      if (!httpResult.notAuthorizedCb && !this.globalUnauthorizedHandler) {
        console.log('No error callback defined - ', axiosError);
      }
    } else if (httpResult.errorCb) {
      httpResult.errorCb(payload);
    } else {
      console.log('No error callback defined - ', axiosError);
    }
  }

  private extractErrorPayload(error: AxiosError) {
    const responseData = error?.response?.data;
    if (responseData && typeof responseData === 'object') {
      const { message, code, statusCode } = responseData as Record<string, any>;
      return {
        message: (message as string) ?? error.message,
        code: (code as string) ?? 'ERR',
        statusCode: (statusCode as number) ?? error?.response?.status ?? 0,
        raw: responseData
      };
    }
    return {
      message: error.message,
      code: 'ERR',
      statusCode: error?.response?.status ?? 0,
      raw: responseData ?? null
    };
  }

  /**
   * streamFetch — POST to an SSE endpoint and return the raw ReadableStream.
   * Bypasses wrapRequest/axios entirely (incompatible with streaming). The user access token
   * lives only in memory (`axios.defaults.headers.common['Authorization']`, rotated by
   * UserService) since the move to HttpOnly-refresh-cookie auth — localStorage no longer
   * carries it, so this reads the same in-memory source `runRequest` relies on via axios's
   * default-header merge. Applies the same pre-emptive/reactive refresh-on-401 self-heal as
   * `runRequest` (see `setTokenRefresher`), which native `fetch` doesn't get for free.
   */
  async streamFetch(url: string, body: unknown, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    return this.execStreamFetch(url, body, signal, false);
  }

  private async execStreamFetch(
    url: string,
    body: unknown,
    signal: AbortSignal | undefined,
    retried: boolean,
  ): Promise<ReadableStream<Uint8Array>> {
    const canSelfHeal =
      this.tokenRefresher != null &&
      !this.isAuthEndpoint(url) &&
      this.getApiToken(url) === undefined &&
      (this.isAuthedProvider == null || this.isAuthedProvider());

    if (!retried && canSelfHeal && this.isTokenStaleProvider?.()) {
      await this.tokenRefresher!();
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiToken = this.getApiToken(url);
    if (apiToken) {
      headers['Authorization'] = `Bearer ${apiToken}`;
    } else {
      const bearer = axios.defaults.headers.common['Authorization'];
      if (typeof bearer === 'string') headers['Authorization'] = bearer;
    }

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!response.ok) {
      if (response.status === 401 && !retried && canSelfHeal) {
        const refreshed = await this.tokenRefresher!();
        if (refreshed) return this.execStreamFetch(url, body, signal, true);
      }
      throw new Error(`HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('No response body');
    return response.body;
  }

  /** Builds the in-flight dedup key: method + URL + serialized body. Falls back to
   *  `String(data)` if the body isn't JSON-serializable (should not happen for the
   *  plain-object bodies this service is called with). */
  private buildDedupeKey(config: AxiosRequestConfig): string {
    const method = (config.method ?? 'get').toUpperCase();
    let bodyPart = '';
    if (config.data !== undefined) {
      try {
        bodyPart = JSON.stringify(config.data);
      } catch {
        bodyPart = String(config.data);
      }
    }
    return `${method} ${config.url ?? ''}::${bodyPart}`;
  }

  /**
   * Entry point used by every verb method. When `options.dedupe` is set, a request
   * matching an already-pending one (same key from `buildDedupeKey`) reuses that
   * pending promise instead of issuing a new HTTP call — `runRequest`'s own 401
   * self-heal retry already runs to completion before this promise settles, so a
   * dedup'd caller only ever observes the final, already-retried outcome (see
   * `HttpRequestOptions.dedupe` doc for the full contract). Without the option this
   * is a pure passthrough to `runRequest`, so default behavior is unchanged.
   */
  private runRequestDeduped<T = any>(
    config: AxiosRequestConfig,
    options?: HttpRequestOptions,
  ): Promise<AxiosResponse<T>> {
    if (!options?.dedupe) return this.runRequest<T>(config, options);

    const key = this.buildDedupeKey(config);
    const existing = this.inFlightRequests.get(key);
    if (existing) return existing as Promise<AxiosResponse<T>>;

    const promise = this.runRequest<T>(config, options).finally(() => {
      // Only clear the entry if it's still the one we registered — guards against a
      // pathological case where the map was cleared/overwritten mid-flight.
      if (this.inFlightRequests.get(key) === promise) {
        this.inFlightRequests.delete(key);
      }
    });
    this.inFlightRequests.set(key, promise);
    return promise;
  }

  private async runRequest<T = any>(
    config: AxiosRequestConfig,
    options?: HttpRequestOptions,
    retried = false,
  ): Promise<AxiosResponse<T>> {
    const wrapOptions = options?.skipTransport
      ? { skipTransport: true }
      : { requestUrl: config.url };
    const exec = () =>
      cryptService.wrapRequest<AxiosResponse<T>>(
        (sessionId) => {
          const headers = { ...(config.headers ?? {}) };
          const hasAuthHeader = Object.keys(headers).some(
            (key) => key?.toLowerCase() === 'authorization',
          );
          if (!hasAuthHeader) {
            const apiToken = this.getApiToken(config.url ?? '');
            if (apiToken) {
              headers.Authorization = `Bearer ${apiToken}`;
            } else if (typeof window !== 'undefined') {
              const userToken = window.localStorage?.getItem('token');
              if (userToken) {
                headers.Authorization = `Bearer ${userToken}`;
              }
            }
          }
          if (sessionId && !options?.skipTransport) {
            headers[TRANSPORT_SESSION_HEADER] = sessionId;
            Object.assign(headers, cryptService.getTransportCapabilityHeaders());
          }
          return axios({
            ...config,
            headers,
            withCredentials: options?.withCredentials,
          });
        },
        wrapOptions,
      );

    // Pre-emptive refresh: if the in-memory access token is already expired (proactive timer
    // drifted while the tab was backgrounded / the machine slept / the network changed), rotate
    // it BEFORE sending the request instead of eating a guaranteed 401 + reactive retry. This is
    // what removes the per-poll 401 console churn on endpoints polled every second. Gated exactly
    // like the reactive retry: only for authenticated user-JWT requests, never for the auth/remote
    // paths. Deduped downstream (the refresher shares a single in-flight promise).
    const reqUrl = config.url ?? '';
    if (
      !retried &&
      this.tokenRefresher != null &&
      this.isTokenStaleProvider != null &&
      this.isTokenStaleProvider() &&
      !this.isAuthEndpoint(reqUrl) &&
      this.getApiToken(reqUrl) === undefined &&
      (this.isAuthedProvider == null || this.isAuthedProvider())
    ) {
      await this.tokenRefresher();
    }

    try {
      return await exec();
    } catch (error) {
      const axiosError = error as AxiosError;
      const url = config.url ?? '';
      // Reactive token refresh: a 401 on a user-JWT request usually means the in-memory
      // access token expired (timer drift after sleep/network change). Rotate it once via
      // the refresh cookie and replay the request — re-running exec() rebuilds the headers
      // from the freshly-updated axios defaults and re-establishes the transport session.
      const canRetry =
        !retried &&
        axiosError?.response?.status === 401 &&
        this.tokenRefresher != null &&
        !this.isAuthEndpoint(url) &&
        this.getApiToken(url) === undefined &&
        (this.isAuthedProvider == null || this.isAuthedProvider());
      if (canRetry) {
        const refreshed = await this.tokenRefresher!();
        if (refreshed) {
          return this.runRequest<T>(config, options, true);
        }
      }
      throw error;
    }
  }
}

export const httpService = new HttpService();
