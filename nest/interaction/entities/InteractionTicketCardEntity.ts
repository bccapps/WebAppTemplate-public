/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { jsonColumnType, timestampColumnType } from '../../common/utils/dbEngine';

/**
 * A card sent on a reply channel (04 §6, §8.3): `card_key` is random (72 bits, base64url), never derived from an id;
 * `binding` ties it to where it was sent (Telegram: `{ botRef, chatId, telegramUserId, messageId }`). A press counts
 * only when it matches the whole binding. `open → closed`. Deleted with its ticket (purge).
 */
@Entity({ name: 'interaction_ticket_card' })
@Index('UQ_ix_ticket_card_key', ['cardKey'], { unique: true })
@Index('IDX_ix_ticket_card_ticket', ['ticketId'])
export class InteractionTicketCardEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'ticket_id', type: 'uuid' })
  ticketId: string;

  @Column({ name: 'user_id', type: 'integer' })
  userId: number;

  @Column({ type: 'varchar', length: 16 })
  kind: string;

  @Column({ name: 'card_key', type: 'varchar', length: 16 })
  cardKey: string;

  @Column({ type: jsonColumnType() })
  binding: Record<string, string>;

  @Column({ type: 'varchar', length: 8 })
  state: string;

  @Column({ type: 'varchar', length: 5 })
  lang: string;

  @CreateDateColumn({ name: 'created_at', type: timestampColumnType() })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: timestampColumnType() })
  updatedAt: Date;
}
