/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export type AuthPrincipalKind = 'user' | 'admin-token';

/** Identity attached to `req.user` once a request is authenticated. */
export interface AuthPrincipal {
  id: number;
  admin: boolean;
  kind: AuthPrincipalKind;
  [key: string]: unknown;
}
