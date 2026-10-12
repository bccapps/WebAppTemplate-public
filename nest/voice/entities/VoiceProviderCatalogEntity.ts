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
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'voice_provider_catalog' })
export class VoiceProviderCatalogEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', unique: true })
  slug!: string;

  @Column({ type: 'text' })
  type!: string;

  @Column({ name: 'capabilities', type: 'simple-array' })
  capabilities!: string[];

  @Column({ name: 'base_url', type: 'text' })
  baseUrl!: string;

  @Column({ type: 'text', nullable: true })
  website!: string | null;

  @Column({ name: 'signup_url', type: 'text', nullable: true })
  signupUrl!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
