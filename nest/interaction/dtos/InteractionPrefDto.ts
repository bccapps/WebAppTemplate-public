/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { InteractionCategory } from '../types/interactionTypes';

/** A user's preferences (04 §11.4). */
export interface InteractionPrefDto {
  quietHours: { start: string; end: string } | null;
  timezone: string;
  criticalBypass: boolean;
  routing: Record<InteractionCategory, string[] | null>;
  inappDisplay: 'toast' | 'browser' | null;
  effectiveInappDisplay: 'toast' | 'browser';
}
