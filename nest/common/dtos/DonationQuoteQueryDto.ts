/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Type } from 'class-transformer';
import { IsIn, IsNumber, Min } from 'class-validator';

export const DONATION_QUOTE_CHAINS = ['bitcoin', 'ethereum', 'bsc', 'base', 'arbitrum', 'solana'] as const;
export type DonationQuoteChain = (typeof DONATION_QUOTE_CHAINS)[number];

export const DONATION_QUOTE_ASSETS = ['BTC', 'ETH', 'USDC', 'USDT', 'SOL'] as const;
export type DonationQuoteAsset = (typeof DONATION_QUOTE_ASSETS)[number];

export class DonationQuoteQueryDto {
  @IsIn(DONATION_QUOTE_CHAINS)
  chain!: DonationQuoteChain;

  @IsIn(DONATION_QUOTE_ASSETS)
  asset!: DonationQuoteAsset;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amountUsd!: number;
}
