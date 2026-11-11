/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** A channel in the administrators' view (04 §11.4): metadata only, never a target nor a secret. */
export interface InteractionChannelAdminDto {
  id: string;
  owner: { userId: number; name: string | null };
  kind: string;
  enabled: boolean;
  adminDisabled: boolean;
  configured: boolean;
  verified: boolean;
  /** The provider's admin view (`adminView`). */
  meta: Record<string, string | number | boolean | null>;
  /** Same as `meta` for the built-in kinds (04 §11.4 shape). */
  telegram?: Record<string, string | number | boolean | null>;
  browser?: Record<string, string | number | boolean | null>;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
