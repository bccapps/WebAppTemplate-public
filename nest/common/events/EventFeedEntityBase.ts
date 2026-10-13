/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { Column, CreateDateColumn, Index, PrimaryGeneratedColumn } from 'typeorm';
import { jsonColumnType, timestampColumnType } from '../../database/dbEngine';

/**
 * Columns of an append-only event feed table (outbox read by consumer apps, see eventFeed.ts).
 * A module declares its own table with `@Entity({ name: '<module>_event' }) class X extends EventFeedEntityBase {}`.
 */
export abstract class EventFeedEntityBase {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 64 })
  type!: string;

  @Column({ type: jsonColumnType() })
  payload!: Record<string, unknown>;

  @Index()
  @CreateDateColumn({ type: timestampColumnType() })
  createdAt!: Date;
}
