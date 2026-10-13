/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { jsonColumnType, timestampColumnType } from '../../database/dbEngine';

export type CookieConsentCategories = { necessary: true; audienceMeasurement: boolean };

/**
 * Append-only proof-of-consent log (CNIL requires being able to demonstrate a choice was made) —
 * one row per banner/modal action, never updated in place. Rows older than the 6-month CNIL
 * consent-validity window are deleted by CookieConsentRetentionCronService; the client-side
 * `vx_cookie_consent` cookie carries the SAME 6-month expiry so the banner re-prompts and a
 * fresh row is written right as the previous one falls out of retention.
 */
@Entity({ name: 'cookie_consent_log' })
export class CookieConsentEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Always null for now — logging is anonymous-only (see CookieConsentController's doc comment). */
  @Column({ type: 'int', nullable: true })
  userId!: number | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  ip!: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  userAgent!: string | null;

  @Column({ type: jsonColumnType() })
  categories!: CookieConsentCategories;

  @CreateDateColumn({ type: timestampColumnType() })
  createdAt!: Date;
}

export default CookieConsentEntity;
