/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { SecurityException } from '../exceptions/SecurityException';
import type { AuthPort } from './AuthPort';
import type { AuthPrincipal } from './AuthPrincipal';
import type { ServicePrincipal } from './ServiceKeyAuth';
import { applyUserIdentity, identityTargets } from './requestIdentity';

/** Minimal shape of the HTTP request touched by the auth interceptors. */
export interface AuthRequest {
  headers?: { authorization?: string | null };
  body?: Record<string, unknown> | null;
  params?: Record<string, unknown> | null;
  query?: Record<string, unknown> | null;
  user?: AuthPrincipal;
  /** Set by `GlobalAuthInterceptor` when a service key was admitted on an `@ApiScope` route (never with `user`). */
  servicePrincipal?: ServicePrincipal;
}

/** Extracts the token from `Authorization: Bearer <token>`; null when absent. */
export function extractBearerToken(req: AuthRequest): string | null {
  const header = req?.headers?.authorization;
  if (header === undefined || header === null) return null;
  return header.split(' ')[1] || null;
}

/** Fingerprint only: a rejected token is still a credential and must not reach the logs. */
export function unrecognizedTokenError(token: string): SecurityException {
  return new SecurityException(
    'AUT',
    `Unrecognized token (len=${String(token).length}, ends=…${String(token).slice(-6)})`,
  );
}

/**
 * Ensures body/params/query exist (and that `query` is an own, mutable object — Express 5
 * re-parses it on every access, see `requestIdentity.ownQuery`) so the principal can be mirrored
 * into them.
 */
export function ensureRequestMembers(req: AuthRequest): void {
  identityTargets(req);
}

/**
 * Sets `req.user` and mirrors it as `uid`/`user` in body, params and query. Client-supplied
 * `uid`/`user` are overwritten in every member, including the Express 5 `query` getter.
 */
export function applyPrincipal(req: AuthRequest, principal: AuthPrincipal): void {
  applyUserIdentity(req, principal);
}

/** Outcome of resolving a token: the principal, or the error the port threw. Never both. */
export interface TokenOutcome {
  principal: AuthPrincipal | null;
  error?: unknown;
}

const outcomes = new WeakMap<object, { token: string; outcome: Promise<TokenOutcome> }>();

/**
 * Resolves `token` through the port at most once per request: the rate-limit guard (which runs before the global
 * auth interceptor) and the interceptor share the result. Never throws: a rejection becomes `outcome.error`.
 * Free of side effects on the request (`req.user` is only set by {@link applyPrincipal}).
 */
export function resolveTokenOnce(port: AuthPort, req: object, token: string): Promise<TokenOutcome> {
  const cached = outcomes.get(req);
  if (cached && cached.token === token) return cached.outcome;
  const outcome = port.resolveToken(token).then(
    (principal): TokenOutcome => ({ principal }),
    (error: unknown): TokenOutcome => ({ principal: null, error }),
  );
  outcomes.set(req, { token, outcome });
  return outcome;
}
