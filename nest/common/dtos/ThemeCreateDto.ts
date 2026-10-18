/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { IsString, MaxLength, MinLength } from 'class-validator';

/** Body of `POST /api/v1/admin/themes` (the LLM drafts the CSS from this description). */
export class ThemeCreateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(5000)
  description!: string;
}
