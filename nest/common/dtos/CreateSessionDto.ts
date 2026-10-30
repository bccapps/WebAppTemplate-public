/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body of the public `POST /api/v1/crypt/session`: an uncompressed P-256 key (65 bytes: 88 base64 / 130 hex chars). */
export class CreateSessionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  clientPublicKey!: string;
}