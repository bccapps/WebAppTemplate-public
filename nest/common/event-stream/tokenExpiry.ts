/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { AuthPrincipal } from '../auth';

const MS_THRESHOLD = 1e12;

function toEpochMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value < MS_THRESHOLD ? value * 1000 : value;
}

/** `exp` claim of a JWT, read without verifying: the global auth interceptor already verified the token. */
function jwtExpiry(authorization: string | undefined): number | null {
  const token = authorization?.split(' ')[1];
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return toEpochMs(claims.exp);
  } catch {
    return null;
  }
}

/**
 * When the stream must be closed so the client reopens it with a fresh token (epoch ms), or `null` when the
 * credential does not expire (admin key, local trust). Order: `principal.exp` (seconds or ms), then the bearer
 * token's `exp` claim.
 */
export function resolveExpiryMs(principal: AuthPrincipal, authorization: string | undefined): number | null {
  return toEpochMs(principal['exp']) ?? jwtExpiry(authorization);
}
