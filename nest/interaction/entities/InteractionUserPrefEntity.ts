/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { jsonColumnType, timestampColumnType } from '../../common/utils/dbEngine';

/** A user's delivery preferences (04 §6). No row = defaults. */
@Entity({ name: 'interaction_user_pref' })
export class InteractionUserPrefEntity {
  @PrimaryColumn({ name: 'user_id', type: 'integer' })
  userId: number;

  /** `HH:mm`; a night window (start after end) is allowed. */
  @Column({ name: 'quiet_hours_start', type: 'varchar', length: 5, nullable: true, default: null })
  quietHoursStart: string | null;

  @Column({ name: 'quiet_hours_end', type: 'varchar', length: 5, nullable: true, default: null })
  quietHoursEnd: string | null;

  /** IANA zone; null = `interaction_defaultTimezone`. */
  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  timezone: string | null;

  @Column({ name: 'critical_bypass', type: 'boolean', default: true })
  criticalBypass: boolean;

  /** `{ info?, approval?, security? }` → list of kinds, or null = every channel. */
  @Column({ type: jsonColumnType(), nullable: true, default: null })
  routing: Record<string, string[] | null> | null;

  /** `toast` | `browser`; null = `interaction_inappDisplayDefault`. */
  @Column({ name: 'inapp_display', type: 'varchar', length: 8, nullable: true, default: null })
  inappDisplay: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: timestampColumnType() })
  updatedAt: Date;
}
