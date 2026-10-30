/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../decorators/Public';
import { DonationService, DonationPublicConfig } from '../services/DonationService';
import { DonationQuoteQueryDto } from '../dtos/DonationQuoteQueryDto';
import { CreateStripeCheckoutDto } from '../dtos/CreateStripeCheckoutDto';

/** Budget of the anonymous Stripe Checkout creation (one Stripe API call per request). */
export const DONATION_CHECKOUT_THROTTLE = { limit: 10, ttl: 600_000 };

/**
 * Public, unauthenticated endpoints for the `DonateButton`/`DonationDialog` widget. No endpoint
 * here tracks or confirms a payment — see `DonationService`'s class doc.
 */
@ApiTags('donations')
@Controller()
export class DonationController {
  constructor(private readonly donationService: DonationService) {}

  @ApiOkResponse({ description: 'Public donation configuration (enabled methods, addresses, presets — never a secret)' })
  @Public()
  @Get('/api/v1/donations/config')
  async getConfig(): Promise<DonationPublicConfig> {
    return this.donationService.getPublicConfig();
  }

  @ApiOkResponse({ description: 'Crypto amount + wallet-ready payment URI for a USD amount on a given chain/asset' })
  @Public()
  @Get('/api/v1/donations/quote')
  async getQuote(@Query() query: DonationQuoteQueryDto) {
    return this.donationService.getQuote(query.chain, query.asset, query.amountUsd);
  }

  @ApiOkResponse({ description: 'Creates a Stripe Checkout session for a USD donation amount, returns its redirect URL' })
  @Public()
  @Throttle({ default: DONATION_CHECKOUT_THROTTLE })
  @Post('/api/v1/donations/stripe/checkout-session')
  async createStripeCheckoutSession(@Body() body: CreateStripeCheckoutDto): Promise<{ url: string }> {
    return this.donationService.createStripeCheckoutSession(body);
  }
}
