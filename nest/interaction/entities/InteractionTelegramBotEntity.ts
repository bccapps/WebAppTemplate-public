/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { timestampColumnType } from '../../common/utils/dbEngine';

/**
 * Reception state of one bot (04 §6): `telegram` = the operator's, `u<userId>` = a user's own. The poll lease is a
 * conditional UPDATE (one poller per bot across instances); the offset is saved after every update.
 */
@Entity({ name: 'interaction_telegram_bot' })
export class InteractionTelegramBotEntity {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  id: string;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  /** Public id of the bot (the part of the token before `:`): a new bot starts from no offset. */
  @Column({ name: 'bot_id', type: 'varchar', length: 32, nullable: true, default: null })
  botId: string | null;

  @Column({ name: 'update_offset', type: 'varchar', length: 20, nullable: true, default: null })
  updateOffset: string | null;

  /** `off` → `starting` → `ok` | `error` (`webhook` when updates come through the webhook route). */
  @Column({ type: 'varchar', length: 16, default: 'off' })
  status: string;

  @Column({ name: 'last_error', type: 'varchar', length: 64, nullable: true, default: null })
  lastError: string | null;

  @Column({ name: 'last_error_at', type: timestampColumnType(), nullable: true, default: null })
  lastErrorAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  failures: number;

  @Column({ name: 'retry_at', type: timestampColumnType(), nullable: true, default: null })
  retryAt: Date | null;

  @Column({ name: 'last_poll_at', type: timestampColumnType(), nullable: true, default: null })
  lastPollAt: Date | null;

  @Column({ name: 'last_update_at', type: timestampColumnType(), nullable: true, default: null })
  lastUpdateAt: Date | null;

  @Column({ name: 'last_message_at', type: timestampColumnType(), nullable: true, default: null })
  lastMessageAt: Date | null;

  @Column({ name: 'received_count', type: 'integer', default: 0 })
  receivedCount: number;

  @Column({ name: 'ignored_count', type: 'integer', default: 0 })
  ignoredCount: number;

  @Column({ name: 'rejected_count', type: 'integer', default: 0 })
  rejectedCount: number;

  @Column({ name: 'last_rejection', type: 'varchar', length: 64, nullable: true, default: null })
  lastRejection: string | null;

  @Column({ name: 'sent_count', type: 'integer', default: 0 })
  sentCount: number;

  @Column({ name: 'dropped_count', type: 'integer', default: 0 })
  droppedCount: number;

  @Column({ name: 'lease_owner', type: 'varchar', length: 64, nullable: true, default: null })
  leaseOwner: string | null;

  @Column({ name: 'lease_until', type: timestampColumnType(), nullable: true, default: null })
  leaseUntil: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: timestampColumnType() })
  updatedAt: Date;
}
