/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** A ticket in the administrators' view (04 §11.4): no summary. */
export interface InteractionTicketAdminDto {
  id: string;
  source: string;
  kind: string;
  category: string;
  status: string;
  recipients: number;
  expiresAt: string;
  answeredVia: string | null;
  answeredAt: string | null;
  createdAt: string;
}
