/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { httpService } from '../core/http/HttpService';
import { configurationService } from './ConfigurationService';

export type DonationEvmChainId = 'ethereum' | 'bsc' | 'base' | 'arbitrum';
export type DonationQuoteChain = 'bitcoin' | DonationEvmChainId | 'solana';
export type DonationQuoteAsset = 'BTC' | 'ETH' | 'USDC' | 'USDT' | 'SOL';

export interface DonationPublicConfig {
  enabledMethods: string[];
  presetAmountsUsd: number[];
  bitcoin: { address: string } | null;
  evm: { address: string; chains: { id: DonationEvmChainId; chainId: number; label: string }[]; assets: string[] } | null;
  solana: { address: string; assets: string[] } | null;
  stripe: { enabled: true } | null;
  paypal: { username: string } | null;
}

export interface DonationQuoteResult {
  amount: string;
  uri: string;
  chainId?: number;
}

function buildEndpoint(path: string): string {
  return `${configurationService.getApiUrl('common')}/donations${path}`;
}

class DonationApi {
  async getPublicConfig(): Promise<DonationPublicConfig> {
    return new Promise((resolve, reject) => {
      httpService
        .get(buildEndpoint('/config'))
        .then(resolve)
        .fail(reject)
        .error(reject)
        .notAuthorized(reject);
    });
  }

  async getQuote(chain: DonationQuoteChain, asset: DonationQuoteAsset, amountUsd: number): Promise<DonationQuoteResult> {
    const query = new URLSearchParams({ chain, asset, amountUsd: String(amountUsd) }).toString();
    return new Promise((resolve, reject) => {
      httpService
        .get(buildEndpoint(`/quote?${query}`))
        .then(resolve)
        .fail(reject)
        .error(reject)
        .notAuthorized(reject);
    });
  }

  async createStripeCheckoutSession(params: { amountUsd: number; successUrl: string; cancelUrl: string }): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      httpService
        .post(buildEndpoint('/stripe/checkout-session'), params)
        .then(resolve)
        .fail(reject)
        .error(reject)
        .notAuthorized(reject);
    });
  }
}

export const donationApi = new DonationApi();
