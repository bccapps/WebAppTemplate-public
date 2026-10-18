/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Identity keys the auth interceptors mirror into the request members. Controllers read them
 * (`body.user`, `@Query('uid')`…) as the authenticated caller, so a client must never be able to
 * supply them itself.
 */
export const IDENTITY_KEYS = ['user', 'uid'] as const;

type Members = Record<string, unknown>;

/** Minimal request shape touched by the identity helpers. */
export interface IdentityRequest {
  body?: unknown;
  params?: unknown;
  query?: unknown;
  user?: unknown;
}

function isMutableObject(value: unknown): value is Members {
  return typeof value === 'object' && value !== null && !Buffer.isBuffer(value);
}

/**
 * Express 5 exposes `req.query` as a getter that re-parses the URL on EVERY access: writing to
 * (or deleting from) the object it returns is silently lost, and `@Query('uid')` then reads the
 * client's value. Shadow it with an own data property holding a mutable copy (harmless on
 * Express 4, where `req.query` already is a plain property). Idempotent.
 */
export function ownQuery(req: IdentityRequest): Members {
  const current = req.query;
  const copy: Members = isMutableObject(current) ? { ...current } : {};
  Object.defineProperty(req, 'query', { value: copy, writable: true, configurable: true, enumerable: true });
  return copy;
}

/** Creates missing body/params, makes query an own mutable object; returns the writable members. */
export function identityTargets(req: IdentityRequest): Members[] {
  if (req.body === undefined || req.body === null) req.body = {};
  if (req.params === undefined || req.params === null) req.params = {};
  const targets: Members[] = [ownQuery(req)];
  if (isMutableObject(req.body)) targets.push(req.body);
  if (isMutableObject(req.params)) targets.push(req.params);
  return targets;
}

/**
 * Removes any client-supplied `user` / `uid` from body, query and params. Call it first thing in
 * every auth interceptor, BEFORE any early return (public route, missing token…).
 */
export function scrubClientIdentity(req: IdentityRequest): void {
  for (const target of identityTargets(req)) {
    for (const key of IDENTITY_KEYS) delete target[key];
  }
}

/** Sets `req.user` and mirrors it as `user` / `uid` into body, query and params. */
export function applyUserIdentity(req: IdentityRequest, user: { id: unknown }): void {
  for (const target of identityTargets(req)) {
    target.uid = user.id;
    target.user = user;
  }
  req.user = user;
}

/**
 * Scrubs the client-supplied identity, then re-mirrors the principal an earlier interceptor
 * already resolved into `req.user` — `req.user` is set by the server only, never parsed from the
 * request.
 */
export function resetRequestIdentity(req: IdentityRequest): void {
  scrubClientIdentity(req);
  const trusted = req.user as { id: unknown } | undefined;
  if (trusted && typeof trusted === 'object') applyUserIdentity(req, trusted);
}
