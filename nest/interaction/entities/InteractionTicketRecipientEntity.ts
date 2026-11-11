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

/** A recipient of a ticket (04 §6). Deleted with its ticket (purge). */
@Entity({ name: 'interaction_ticket_recipient' })
@Index('IDX_ix_ticket_recipient_user', ['userId'])
export class InteractionTicketRecipientEntity {
  @PrimaryColumn({ name: 'ticket_id', type: 'uuid' })
  ticketId: string;

  @PrimaryColumn({ name: 'user_id', type: 'integer' })
  userId: number;

  @Column({ name: 'notified_at', type: timestampColumnType() })
  notifiedAt: Date;

  @Column({ name: 'seen_at', type: timestampColumnType(), nullable: true, default: null })
  seenAt: Date | null;
}
