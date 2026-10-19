/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Type } from 'class-transformer';
import { IsNumber, IsUrl, Min } from 'class-validator';

export class CreateStripeCheckoutDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  amountUsd!: number;

  @IsUrl({ require_tld: false })
  successUrl!: string;

  @IsUrl({ require_tld: false })
  cancelUrl!: string;
}
