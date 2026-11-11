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

/**
 * Delivery journal and deduplication (04 §6), WITHOUT content: the unique index `(user_id, dedup_key, kind)` reserves a
 * delivery before it is sent (invariant 3). States: `queued → sent | failed`; `skipped` and `duplicate` final.
 */
@Entity({ name: 'interaction_delivery' })
@Index('UQ_ix_delivery_dedup', ['userId', 'dedupKey', 'kind'], { unique: true })
@Index('IDX_ix_delivery_user_kind', ['userId', 'kind', 'createdAt'])
@Index('IDX_ix_delivery_kind_created', ['kind', 'createdAt'])
export class InteractionDeliveryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'integer' })
  userId: number;

  @Column({ name: 'dedup_key', type: 'varchar', length: 140 })
  dedupKey: string;

  @Column({ type: 'varchar', length: 16 })
  kind: string;

  @Column({ type: 'varchar', length: 12 })
  category: string;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  @Column({ name: 'ticket_id', type: 'uuid', nullable: true, default: null })
  ticketId: string | null;

  @Column({ type: 'varchar', length: 10 })
  status: string;

  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  code: string | null;

  @CreateDateColumn({ name: 'created_at', type: timestampColumnType() })
  createdAt: Date;

  @Column({ name: 'sent_at', type: timestampColumnType(), nullable: true, default: null })
  sentAt: Date | null;
}
