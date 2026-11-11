/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { jsonColumnType, timestampColumnType } from '../../common/utils/dbEngine';
import type { InteractionText } from '../types/interactionTypes';

/** The in-app inbox (04 §6): one row per notice of a user, the texts as `InteractionText` (masked, bounded). */
@Entity({ name: 'interaction_notice' })
@Index('IDX_ix_notice_user_read', ['userId', 'readAt', 'createdAt'])
export class InteractionNoticeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'integer' })
  userId: number;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  @Column({ type: 'varchar', length: 40 })
  source: string;

  @Column({ type: 'varchar', length: 12 })
  category: string;

  @Column({ type: 'varchar', length: 8 })
  priority: string;

  @Column({ type: jsonColumnType() })
  title: InteractionText;

  @Column({ type: jsonColumnType(), nullable: true, default: null })
  body: InteractionText | null;

  /** Relative path of the app. */
  @Column({ type: 'varchar', length: 512, nullable: true, default: null })
  url: string | null;

  @Column({ type: jsonColumnType(), nullable: true, default: null })
  data: Record<string, string | number | boolean> | null;

  @Column({ name: 'ticket_id', type: 'uuid', nullable: true, default: null })
  ticketId: string | null;

  @CreateDateColumn({ name: 'created_at', type: timestampColumnType() })
  createdAt: Date;

  @Column({ name: 'read_at', type: timestampColumnType(), nullable: true, default: null })
  readAt: Date | null;
}
