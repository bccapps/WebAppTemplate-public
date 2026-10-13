/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { jsonColumnType, timestampColumnType } from '../../common/utils/dbEngine';
import { VoiceProviderCatalogEntity } from './VoiceProviderCatalogEntity';

@Entity({ name: 'user_voice_accesses' })
@Index('IDX_user_voice_accesses_user', ['userId'])
@Unique('UQ_user_voice_accesses_user_label', ['userId', 'label'])
export class UserVoiceAccessEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /**
   * Plain column on purpose: voice must not depend on the private user module.
   * Users are never hard-deleted (anonymization only), so the former
   * ON DELETE CASCADE had no effect.
   */
  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ type: 'text' })
  label!: string;

  @Column({ name: 'provider_id', type: 'int' })
  providerId!: number;

  @ManyToOne(() => VoiceProviderCatalogEntity, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'provider_id' })
  provider!: VoiceProviderCatalogEntity;

  @Column({ name: 'base_url_override', type: 'text', nullable: true })
  baseUrlOverride!: string | null;

  @Column({ type: 'text', nullable: true })
  username!: string | null;

  @Column({ type: 'text', nullable: true })
  password!: string | null;

  @Column({ name: 'provider_config', type: jsonColumnType(), nullable: true })
  providerConfig!: Record<string, any> | null;

  @CreateDateColumn({ name: 'created_at', type: timestampColumnType() })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: timestampColumnType() })
  updatedAt!: Date;
}
