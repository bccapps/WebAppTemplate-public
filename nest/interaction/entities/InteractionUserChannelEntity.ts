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
 * A channel configured by a user (04 §6). Never `inapp` (always present, no row). Targets live in `config` (owner's view
 * only), secrets in `InteractionSecretStore` (`secret_id`). `admin_disabled` is lifted by an administrator only.
 */
@Entity({ name: 'interaction_user_channel' })
@Index('UQ_ix_user_channel_user_kind', ['userId', 'kind'], { unique: true })
// Review F5: one provider uniqueness key per kind (a Telegram bot serves ONE user); NULLs are distinct on both engines.
@Index('UQ_ix_user_channel_kind_key', ['kind', 'externalKey'], { unique: true })
export class InteractionUserChannelEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'integer' })
  userId: number;

  @Column({ type: 'varchar', length: 16 })
  kind: string;

  /** The owner's switch. */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'admin_disabled', type: 'boolean', default: false })
  adminDisabled: boolean;

  @Column({ name: 'admin_disabled_by', type: 'integer', nullable: true, default: null })
  adminDisabledBy: number | null;

  @Column({ name: 'admin_disabled_at', type: timestampColumnType(), nullable: true, default: null })
  adminDisabledAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  position: number;

  /** Non-secret configuration (`mode`, `botId`, `botUsername`, `inbound`…), validated by the provider. */
  @Column({ type: jsonColumnType() })
  config: Record<string, unknown>;

  /** `{ pendingTarget, codeHash, expiresAt, attempts }`: never a code. */
  @Column({ type: jsonColumnType(), nullable: true, default: null })
  verification: Record<string, unknown> | null;

  @Column({ name: 'secret_id', type: 'uuid', nullable: true, default: null })
  secretId: string | null;

  /** Uniqueness key of the provider (Telegram: the bot id). */
  @Column({ name: 'external_key', type: 'varchar', length: 64, nullable: true, default: null })
  externalKey: string | null;

  @Column({ name: 'verified_at', type: timestampColumnType(), nullable: true, default: null })
  verifiedAt: Date | null;

  @Column({ name: 'last_test_at', type: timestampColumnType(), nullable: true, default: null })
  lastTestAt: Date | null;

  /** `ok` | `failed`. */
  @Column({ name: 'last_test_status', type: 'varchar', length: 8, nullable: true, default: null })
  lastTestStatus: string | null;

  @Column({ name: 'last_test_error', type: 'varchar', length: 64, nullable: true, default: null })
  lastTestError: string | null;

  @Column({ name: 'last_used_at', type: timestampColumnType(), nullable: true, default: null })
  lastUsedAt: Date | null;

  /** A code (04 §12.3), cleared by a success. */
  @Column({ name: 'last_error', type: 'varchar', length: 64, nullable: true, default: null })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: timestampColumnType() })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: timestampColumnType() })
  updatedAt: Date;
}
