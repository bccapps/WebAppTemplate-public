/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body of `POST /api/v1/crypt/admin/decrypt` (admin diagnostics of an encrypted column value). */
export class DecryptPayloadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  payload!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  namespace?: string;
}
