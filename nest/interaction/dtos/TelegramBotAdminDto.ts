/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Reception state of a bot (04 §11.4): no token, no chat. */
export interface TelegramBotAdminDto {
  ref: 'operator' | 'user';
  ownerUserId: number | null;
  botUsername: string | null;
  status: string;
  lastError: string | null;
  lastPollAt: string | null;
  received: number;
  ignored: number;
  rejected: number;
  sent: number;
  dropped: number;
}
