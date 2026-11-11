/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { InteractionText } from '../types/interactionTypes';

/** A notice of the in-app inbox (04 §11.4): texts as `InteractionText`, rendered by the front in the user's language. */
export interface InteractionNoticeDto {
  id: string;
  type: string;
  source: string;
  category: string;
  priority: string;
  title: InteractionText;
  body: InteractionText | null;
  url: string | null;
  data: Record<string, string | number | boolean> | null;
  ticketId: string | null;
  createdAt: string;
  readAt: string | null;
}
