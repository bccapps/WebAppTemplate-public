/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { IsString, MaxLength } from 'class-validator';

/** Body of `PUT /api/v1/admin/themes/:id/css`. */
export class ThemeCssUpdateDto {
  @IsString()
  @MaxLength(1_000_000)
  css!: string;
}
