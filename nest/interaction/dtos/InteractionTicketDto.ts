/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { InteractionSummary, InteractionText } from '../types/interactionTypes';

/** A ticket as its recipient sees it (04 §11.4). `allowedHere`: answerable from the in-app modal. */
export interface InteractionTicketDto {
  id: string;
  kind: string;
  source: string;
  category: string;
  summary: InteractionSummary;
  actions: Array<{ id: string; label: InteractionText; style: string; allowedHere: boolean }>;
  answerableFrom: string[];
  /** 04 §21: the answer needs a step-up proof bound to `stepUpPurpose`. */
  freshProofRequired: boolean;
  stepUpPurpose: string | null;
  status: string;
  expiresAt: string;
  answeredVia: string | null;
  answeredAt: string | null;
  answeredByMe: boolean;
  createdAt: string;
}
