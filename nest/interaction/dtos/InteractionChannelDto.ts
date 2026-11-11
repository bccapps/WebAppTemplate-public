/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { InteractionProof } from '../types/interactionTypes';

/** A channel of the signed-in user (04 §11.4). `view` is the provider's owner view: never a secret. */
export interface InteractionChannelDto {
  kind: string;
  id: string | null;
  enabled: boolean;
  adminDisabled: boolean;
  configured: boolean;
  verified: boolean;
  ready: boolean;
  position: number;
  capabilities: string[];
  /** 04 §22: how the channel can bring the proof of a `freshProof` question (`inapp`: `in_app`). */
  proof: InteractionProof;
  view: Record<string, unknown>;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}
