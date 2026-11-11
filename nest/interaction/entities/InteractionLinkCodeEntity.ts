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

export type TelegramLinkOutcome = 'linked' | 'already_linked' | 'conflict' | 'limit';

/** A one-time Telegram link code (04 §6, §9): only its SHA-256 is stored; consumed by a conditional UPDATE. */
@Entity({ name: 'interaction_link_code' })
@Index('UQ_ix_link_code_hash', ['codeHash'], { unique: true })
@Index('IDX_ix_link_code_bot', ['botRef'])
export class InteractionLinkCodeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'bot_ref', type: 'varchar', length: 16 })
  botRef: string;

  @Column({ name: 'user_id', type: 'integer', nullable: true, default: null })
  userId: number | null;

  @Column({ name: 'code_hash', type: 'varchar', length: 64 })
  codeHash: string;

  @Column({ name: 'expires_at', type: timestampColumnType() })
  expiresAt: Date;

  @Column({ name: 'used_at', type: timestampColumnType(), nullable: true, default: null })
  usedAt: Date | null;

  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  outcome: TelegramLinkOutcome | null;

  @CreateDateColumn({ name: 'created_at', type: timestampColumnType() })
  createdAt: Date;
}
