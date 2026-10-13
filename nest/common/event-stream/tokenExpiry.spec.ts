/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import type { AuthPrincipal } from '../auth';
import { resolveExpiryMs } from './tokenExpiry';

const principal = (extra: Record<string, unknown> = {}): AuthPrincipal => ({ id: 1, admin: false, kind: 'user', ...extra });
const jwt = (claims: object): string =>
  `Bearer h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('resolveExpiryMs', () => {
  it('prefers principal.exp, in seconds or milliseconds', () => {
    expect(resolveExpiryMs(principal({ exp: 1_800_000_000 }), undefined)).toBe(1_800_000_000_000);
    expect(resolveExpiryMs(principal({ exp: 1_800_000_000_000 }), undefined)).toBe(1_800_000_000_000);
  });

  it('falls back to the bearer token exp claim', () => {
    expect(resolveExpiryMs(principal(), jwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
  });

  it('is null for non expiring credentials and malformed tokens', () => {
    expect(resolveExpiryMs(principal(), undefined)).toBeNull();
    expect(resolveExpiryMs(principal(), 'Bearer plain-admin-key')).toBeNull();
    expect(resolveExpiryMs(principal(), 'Bearer a.%%%.c')).toBeNull();
    expect(resolveExpiryMs(principal({ exp: 'soon' }), undefined)).toBeNull();
  });
});
