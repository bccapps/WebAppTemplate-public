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
import type { InteractionAction, InteractionSummary } from '../types/interactionTypes';

/**
 * A question (04 §6, §8). `open → answered | expired | cancelled` by conditional UPDATEs only (first answer wins); the
 * outcome is handed to the `onAnswer` handler through `dispatch_*` (`none → pending → done | failed`, 5 attempts).
 */
@Entity({ name: 'interaction_ticket' })
@Index('UQ_ix_ticket_correlation', ['source', 'correlationId'], { unique: true })
@Index('IDX_ix_ticket_status_exp', ['status', 'expiresAt'])
@Index('IDX_ix_ticket_dispatch', ['dispatchStatus', 'dispatchNextAt'])
export class InteractionTicketEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 40 })
  source: string;

  @Column({ type: 'varchar', length: 64 })
  kind: string;

  @Column({ name: 'correlation_id', type: 'varchar', length: 128 })
  correlationId: string;

  @Column({ type: 'varchar', length: 12 })
  category: string;

  @Column({ type: jsonColumnType() })
  summary: InteractionSummary;

  @Column({ type: jsonColumnType() })
  actions: InteractionAction[];

  @Column({ name: 'answerable_from', type: jsonColumnType(), nullable: true, default: null })
  answerableFrom: string[] | null;

  /** 04 §21: the answer needs a step-up proof (in-app only). Replaces `fresh_session_seconds` of 04 §6. */
  @Column({ name: 'fresh_proof', type: 'boolean', default: false })
  freshProof: boolean;

  @Column({ type: 'varchar', length: 12 })
  status: string;

  @Column({ name: 'expires_at', type: timestampColumnType() })
  expiresAt: Date;

  @Column({ name: 'answer_action', type: 'varchar', length: 16, nullable: true, default: null })
  answerAction: string | null;

  @Column({ name: 'answered_via', type: 'varchar', length: 16, nullable: true, default: null })
  answeredVia: string | null;

  @Column({ name: 'answered_by', type: 'integer', nullable: true, default: null })
  answeredBy: number | null;

  @Column({ name: 'answered_at', type: timestampColumnType(), nullable: true, default: null })
  answeredAt: Date | null;

  @Column({ name: 'cancel_reason', type: 'varchar', length: 64, nullable: true, default: null })
  cancelReason: string | null;

  @Column({ name: 'dispatch_status', type: 'varchar', length: 10, default: 'none' })
  dispatchStatus: string;

  @Column({ name: 'dispatch_attempts', type: 'integer', default: 0 })
  dispatchAttempts: number;

  @Column({ name: 'dispatch_next_at', type: timestampColumnType(), nullable: true, default: null })
  dispatchNextAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: timestampColumnType() })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: timestampColumnType() })
  updatedAt: Date;
}
