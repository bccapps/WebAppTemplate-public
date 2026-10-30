/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Body of the public `POST /api/v1/donations/stripe/checkout-session`. The two URLs are checked by `DonationService`
 * against the front origins of the app (`CLIENT_ORIGINS`): an absolute URL of an allowed origin or a `/path`.
 */
export class CreateStripeCheckoutDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(999_999)
  amountUsd!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  successUrl!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  cancelUrl!: string;
}
