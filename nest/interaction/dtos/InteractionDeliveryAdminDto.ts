/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** One delivery of the journal (04 §11.4): codes only, never a content nor a target. */
export interface InteractionDeliveryAdminDto {
  id: string;
  userId: number;
  kind: string;
  category: string;
  type: string;
  status: string;
  code: string | null;
  createdAt: string;
  sentAt: string | null;
}
