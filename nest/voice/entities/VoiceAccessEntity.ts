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
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { jsonColumnType, timestampColumnType } from '../../database/dbEngine';
import { VoiceProviderCatalogEntity } from './VoiceProviderCatalogEntity';

@Entity({ name: 'voice_accesses' })
export class VoiceAccessEntity {
  @PrimaryGeneratedColumn()
  id!: number;

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
