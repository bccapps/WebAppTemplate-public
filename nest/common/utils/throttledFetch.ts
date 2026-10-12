/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { Logger } from '@nestjs/common';

/**
 * Generic outbound-HTTP protection for any external API call: a per-source minimum spacing
 * between requests (anti-429 on free/free-tier APIs, most of which enforce a hard quota), plus
 * exponential-backoff-with-jitter retry on 429/5xx, honoring a `Retry-After` header when the
 * transport can supply one. Never throws — a request that never succeeds resolves to
 * `{ data: null, stale: true }` so a caller's own collection loop is never interrupted by one
 * failing source.
 *
 * Generalized out of market-data's original per-source `fetchJson` (which now delegates here —
 * see `market-data/utils/fetchJson.ts` for its per-source interval table and backward-compatible
 * wrapper), so any module making outbound calls to a rate-limited third party can reuse the same
 * spacing+backoff instead of re-deriving it. `rateLimitLedger.ts` is the companion PROACTIVE
 * primitive (checks budget headroom before calling at all, e.g. for routing across N credentials)
 * — this file is the REACTIVE one (space calls out, back off on an actual 429/5xx).
 */

export interface ThrottledFetchTransportResult {
  readonly status: number;
  readonly body: unknown;
  /** Seconds or HTTP-date form of a `Retry-After` response header, when the transport can read one. */
  readonly retryAfter?: string | null;
}

/** A pluggable transport, e.g. so a caller can inject a test double instead of hitting the network. */
export type ThrottledFetchTransport = (url: string, signal: AbortSignal) => Promise<ThrottledFetchTransportResult>;

export interface ThrottledFetchOptions {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly minIntervalMs?: number;
  /** Backoff ceiling before jitter, ms. Default 30_000. */
  readonly maxBackoffMs?: number;
  /** Method/headers/body for the default `fetch` transport (e.g. a POST or an auth header). Ignored with a custom `transport`. */
  readonly init?: RequestInit;
  readonly transport?: ThrottledFetchTransport;
}

export interface ThrottledFetchResult<T> {
  readonly data: T | null;
  readonly stale: boolean;
  readonly status: number;
  /** True only when every retry was exhausted while the failure was specifically 429/Retry-After — lets a caller's health/alerting distinguish "rate-limited" from "no data available". */
  readonly rateLimited: boolean;
}

const buckets = new Map<string, number>();
const logger = new Logger('throttledFetch');

const fetchTransport = (init: RequestInit = {}): ThrottledFetchTransport => async (url, signal) => {
  const response = await fetch(url, { ...init, signal, headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) } });
  let body: unknown = null;
  try { body = await response.json() as unknown; } catch { body = null; }
  return { status: response.status, body, retryAfter: response.headers?.get('retry-after') ?? null };
};

function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(value);
  return Number.isNaN(asDate) ? null : Math.max(0, asDate - Date.now());
}

/** Exponential backoff with 50–100% jitter (avoids every replica retrying in lockstep), floored by any `Retry-After` the server actually asked for. */
function computeBackoffMs(attempt: number, maxBackoffMs: number, retryAfterMs: number | null): number {
  const exponential = Math.min(maxBackoffMs, 1000 * 2 ** attempt);
  const jittered = exponential * (0.5 + Math.random() * 0.5);
  return retryAfterMs !== null ? Math.max(retryAfterMs, jittered) : jittered;
}

/**
 * GET JSON with per-source throttling + exponential backoff on 429/5xx. Never throws.
 */
export async function throttledFetchJson<T>(
  sourceId: string,
  url: string,
  opts: ThrottledFetchOptions,
): Promise<ThrottledFetchResult<T>> {
  const minInterval = opts.minIntervalMs ?? 0;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  const transport = opts.transport ?? fetchTransport(opts.init);

  if (minInterval > 0) {
    const last = buckets.get(sourceId) ?? 0;
    const wait = minInterval - (Date.now() - last);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  let attempt = 0;
  let lastStatus = 0;
  while (attempt <= opts.maxRetries) {
    try {
      buckets.set(sourceId, Date.now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      let result: ThrottledFetchTransportResult;
      try {
        result = await transport(url, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      lastStatus = result.status;
      if (result.status === 429 || result.status >= 500) {
        if (attempt >= opts.maxRetries) break; // last allowed attempt already spent — no point backing off further
        const retryAfterMs = parseRetryAfterMs(result.retryAfter);
        const backoff = computeBackoffMs(attempt, maxBackoffMs, retryAfterMs);
        logger.warn(`${sourceId} HTTP ${result.status}, retry in ${Math.round(backoff)}ms (attempt ${attempt + 1})`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        attempt += 1;
        continue;
      }
      if (result.status < 200 || result.status >= 300) return { data: null, stale: true, status: result.status, rateLimited: false };
      return { data: result.body as T, stale: false, status: result.status, rateLimited: false };
    } catch (error) {
      lastStatus = 0;
      if (attempt >= opts.maxRetries) break; // last allowed attempt already spent — no point backing off further
      const backoff = computeBackoffMs(attempt, maxBackoffMs, null);
      logger.warn(`${sourceId} fetch failed (${(error as Error).message}), retry in ${Math.round(backoff)}ms`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      attempt += 1;
    }
  }
  return { data: null, stale: true, status: lastStatus, rateLimited: lastStatus === 429 };
}

/** Test-only: clears every source's throttle bucket. */
export function resetThrottleBuckets(): void {
  buckets.clear();
}
