/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { InteractionNoticeDto } from './InteractionNoticeDto';
import type { InteractionTicketDto } from './InteractionTicketDto';

/** Open tickets, unread notices (100 at most) and the badge count (04 §11.4). */
export interface InboxDto {
  tickets: InteractionTicketDto[];
  notices: InteractionNoticeDto[];
  unread: number;
}
