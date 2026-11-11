/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { timestampColumnType } from '../../common/utils/dbEngine';

/**
 * The Telegram updates the webhook route has already taken (second review, finding 3): one row per (bot, `update_id`),
 * the primary key making the claim race-safe. A SET, not a monotonic offset: an older update arriving after a newer one
 * is still handled, exactly once. Kept `WEBHOOK_SEEN_RETENTION_MS` (daily purge); webhook mode only.
 */
@Entity({ name: 'interaction_telegram_update' })
@Index('IDX_ix_tg_update_seen', ['seenAt'])
export class InteractionTelegramUpdateEntity {
  @PrimaryColumn({ name: 'bot_ref', type: 'varchar', length: 16 })
  botRef: string;

  @PrimaryColumn({ name: 'update_id', type: 'varchar', length: 20 })
  updateId: string;

  @Column({ name: 'seen_at', type: timestampColumnType() })
  seenAt: Date;
}
