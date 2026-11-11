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

/** One browser of a user subscribed to Web Push (04 §6). The endpoint is a target: never in a view, a log or an event. */
@Entity({ name: 'interaction_webpush_subscription' })
@Index('UQ_ix_webpush_endpoint', ['endpoint'], { unique: true })
@Index('IDX_ix_webpush_user', ['userId'])
export class InteractionWebPushSubscriptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'integer' })
  userId: number;

  @Column({ type: 'text' })
  endpoint: string;

  @Column({ type: 'varchar', length: 256 })
  p256dh: string;

  @Column({ type: 'varchar', length: 256 })
  auth: string;

  @Column({ name: 'user_agent', type: 'varchar', length: 256, nullable: true, default: null })
  userAgent: string | null;

  @CreateDateColumn({ name: 'created_at', type: timestampColumnType() })
  createdAt: Date;

  @Column({ name: 'last_used_at', type: timestampColumnType(), nullable: true, default: null })
  lastUsedAt: Date | null;
}
