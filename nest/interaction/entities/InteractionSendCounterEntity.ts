/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { timestampColumnType } from '../../common/utils/dbEngine';

/** `email_code`, `channel_test`, `link_code`. */
export type InteractionSendKind = 'email_code' | 'channel_test' | 'link_code';

/** Sends a user asks for (codes, tests, link codes), counted for the persisted caps (04 §6). Kept 48 h. */
@Entity({ name: 'interaction_send_counter' })
@Index('IDX_ix_send_kind_at', ['kind', 'at'])
@Index('IDX_ix_send_kind_user', ['kind', 'userId', 'at'])
@Index('IDX_ix_send_kind_ip', ['kind', 'ip', 'at'])
@Index('IDX_ix_send_kind_target', ['kind', 'targetHash', 'at'])
export class InteractionSendCounterEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  kind: InteractionSendKind;

  @Column({ name: 'user_id', type: 'integer' })
  userId: number;

  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  ip: string | null;

  /** SHA-256 (hex) of the normalised recipient. */
  @Column({ name: 'target_hash', type: 'varchar', length: 64, nullable: true, default: null })
  targetHash: string | null;

  @Column({ type: timestampColumnType() })
  at: Date;
}
