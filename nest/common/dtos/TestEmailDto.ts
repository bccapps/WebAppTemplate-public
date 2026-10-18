/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { IsString, MaxLength, MinLength } from 'class-validator';

/** Body of `POST /api/v1/admin/email/test`. */
export class TestEmailDto {
  @IsString()
  @MinLength(3)
  @MaxLength(320)
  to!: string;
}
