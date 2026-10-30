/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Service (machine-to-machine) credentials, optional. A module that knows how to check API keys (`api-access`)
 * provides a `ServiceKeyAuthenticator` under `SERVICE_KEY_AUTH` (`{ provide: SERVICE_KEY_AUTH, useExisting: X }`,
 * exported from a global scope); `GlobalAuthInterceptor` injects it with `@Optional()` and only consults it on
 * routes marked `@ApiScope(scope)`. Absent => scoped routes keep their normal user authentication only.
 */
export const SERVICE_KEY_AUTH = 'SERVICE_KEY_AUTH';

/** Caller admitted by a service key: an application, never a user (`req.user` stays undefined). */
export interface ServicePrincipal {
  kind: 'service';
  /** Scope the route required (and the key carries). */
  scope: string;
  tenantId: number;
  keyId: number;
}

/** Request members a service-key check reads. */
export interface ServiceKeyRequest {
  headers?: Record<string, string | string[] | undefined | null>;
  ip?: string;
  body?: unknown;
}

export interface ServiceKeyAuthenticator {
  /**
   * Null when the request carries no service key (the normal user authentication then applies). Throws 401 for
   * an invalid / revoked / expired key, 403 when the key lacks `scope`, 429 when it is over its rate limit.
   */
  authenticate(req: ServiceKeyRequest, scope: string): Promise<ServicePrincipal | null>;
  /**
   * Optional, for the rate limiter of `common` (`CommonThrottlerGuard`): the id of the service key the request carries when
   * it is a real, active, unexpired one — else null. Never throws and never counts the call (that stays `authenticate`'s,
   * or the provider's own route guard's); the lookup is made once per request and reused by them.
   */
  verifiedKeyId?(req: ServiceKeyRequest): Promise<number | null>;
}

/** The service principal `GlobalAuthInterceptor` attached to the request, if any. */
export function servicePrincipalOf(req: unknown): ServicePrincipal | undefined {
  const principal = (req as { servicePrincipal?: ServicePrincipal } | null | undefined)?.servicePrincipal;
  return principal?.kind === 'service' ? principal : undefined;
}
