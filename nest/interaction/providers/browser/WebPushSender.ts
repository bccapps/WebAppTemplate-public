/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { assertReachable, defaultGuard, guardedHttpsAgent, NetGuardError, type AddressGuard } from '../../utils/netGuard';

/** What `web-push` exposes and the module uses (loaded on demand: the dependency is the module's `package.fragment.json`). */
export interface WebPushLibrary {
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number; timeout: number; agent: unknown; urgency?: string },
  ): Promise<{ statusCode: number }>;
}

export interface WebPushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** `status`: the push service's HTTP status of a refusal (404 / 410: the subscription is gone). */
export interface WebPushResult {
  ok: boolean;
  status: number | null;
  code: string | null;
}

/** The response of a push service is a status and a short body: more than this is cut off (the socket is destroyed). */
export const WEB_PUSH_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * One Web Push message (extracted from AgentHub `WebPushService.sendNotification`). The endpoint is a URL a browser gave
 * the user (normally a push service of Google, Mozilla, Apple, Microsoft); a user could also post any `https` URL, so
 * the call goes through the SSRF guard (04 §14): literal private address refused before, every name resolved and
 * checked at connection time (guarded `https.Agent`), private ranges never allowed, and the socket bounded (a hard
 * deadline of `timeoutMs` and `WEB_PUSH_MAX_RESPONSE_BYTES` received: `web-push` buffers the whole response and only
 * has an idle timeout, so an endpoint streaming forever would otherwise grow the process memory without end). Never
 * throws; codes only: whatever the library throws (its `WebPushError` carries the endpoint and the response body) is
 * reduced here, at the module boundary, to `HTTP_<status>`, `TIMEOUT`, `NETWORK` or a guard code.
 */
@Injectable()
export class WebPushSender {
  private loaded: Promise<WebPushLibrary | null> | null = null;

  /** The guard used for the endpoints (tests replace the resolver). */
  protected guard(): AddressGuard {
    return defaultGuard(false);
  }

  /** `web-push`, loaded once on first use; null when it is not installed (tests replace it). */
  protected library(): Promise<WebPushLibrary | null> {
    const name = 'web-push';
    this.loaded ??= import(name).then(
      (mod: { default?: WebPushLibrary } & WebPushLibrary) => (typeof mod.sendNotification === 'function' ? mod : mod.default ?? null),
      () => null,
    );
    return this.loaded;
  }

  async send(target: WebPushTarget, payload: string, vapid: { subject: string; publicKey: string; privateKey: string }, timeoutMs: number): Promise<WebPushResult> {
    const guard = this.guard();
    let url: URL;
    try {
      url = new URL(target.endpoint);
      if (url.protocol !== 'https:') return { ok: false, status: null, code: 'ADDRESS_REFUSED' };
      await assertReachable(url, guard);
    } catch (error) {
      return { ok: false, status: null, code: error instanceof NetGuardError ? error.code : 'ADDRESS_REFUSED' };
    }
    const lib = await this.library().catch(() => null);
    if (!lib) return { ok: false, status: null, code: 'NOT_CONFIGURED' };
    try {
      // The URL the guard judged, serialized (`web-push` re-parses it with the legacy `url.parse`: no parser differential).
      await lib.sendNotification({ endpoint: url.toString(), keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
        vapidDetails: vapid,
        TTL: 3600,
        timeout: timeoutMs,
        agent: guardedHttpsAgent(guard, { deadlineMs: timeoutMs, maxBytes: WEB_PUSH_MAX_RESPONSE_BYTES }),
      });
      return { ok: true, status: 201, code: null };
    } catch (error) {
      return webPushFailure(error);
    }
  }
}

/** A failed send as a code (never the error's message, endpoint or body). */
export function webPushFailure(error: unknown): WebPushResult {
  if (error instanceof NetGuardError) return { ok: false, status: null, code: error.code };
  const status = error && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return { ok: false, status, code: `HTTP_${status}` };
  const name = error && typeof error === 'object' ? (error as { name?: unknown; code?: unknown }) : {};
  if (name.name === 'AbortError' || name.name === 'TimeoutError' || name.code === 'ETIMEDOUT' || name.code === 'ESOCKETTIMEDOUT') return { ok: false, status: null, code: 'TIMEOUT' };
  if (error instanceof Error && /timeout/i.test(error.message)) return { ok: false, status: null, code: 'TIMEOUT' };
  return { ok: false, status: null, code: 'NETWORK' };
}
