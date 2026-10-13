/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { LocalTrustRequest } from './localTrust';
import type { AuthPrincipal } from './AuthPrincipal';

export const AUTH_PORT = Symbol('AUTH_PORT');

export interface AuthPort {
  /** 'users' = full user management; 'anonymous' = no users, admin through ADMIN_TOKEN only. */
  readonly mode: 'users' | 'anonymous';
  resolveToken(token: string): Promise<AuthPrincipal | null>;
  /** Principal granted without a token (local trust mode); `null` when the request must authenticate normally. */
  resolveRequest?(req: LocalTrustRequest): AuthPrincipal | null;
}
