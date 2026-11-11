/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { timestampColumnType } from '../../common/utils/dbEngine';

/** Where the link came from: `code` (`/start <code>`, proven), `declared` (by an admin) or `legacy` (imported, never proven). */
export type TelegramLinkSource = 'code' | 'declared' | 'legacy';

/**
 * A Telegram account linked to a user on a bot (04 §6, §9): `bot_ref` = `telegram` (the operator's bot) or `u<userId>`
 * (a user's own bot). One Telegram account belongs to one user in the app. ONLY a `code` link may answer a question.
 */
@Entity({ name: 'interaction_telegram_link' })
@Index('UQ_ix_tg_link_bot_account', ['botRef', 'telegramUserId'], { unique: true })
@Index('IDX_ix_tg_link_account', ['telegramUserId'])
@Index('IDX_ix_tg_link_user', ['userId'])
export class InteractionTelegramLinkEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'bot_ref', type: 'varchar', length: 16 })
  botRef: string;

  /** Null = local administrator without an account (operator's bot, `declared` / `legacy`). */
  @Column({ name: 'user_id', type: 'integer', nullable: true, default: null })
  userId: number | null;

  @Column({ name: 'telegram_user_id', type: 'varchar', length: 20 })
  telegramUserId: string;

  @Column({ name: 'chat_id', type: 'varchar', length: 32 })
  chatId: string;

  /** `@username` or first name: shown to its owner only. */
  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  label: string | null;

  @Column({ type: 'varchar', length: 16 })
  source: TelegramLinkSource;

  @CreateDateColumn({ name: 'created_at', type: timestampColumnType() })
  createdAt: Date;
}
