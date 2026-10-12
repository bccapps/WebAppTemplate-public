/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class IdParamDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id!: number;
}
