/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { throttledFetchJson } from '../utils/throttledFetch';

export type DonationPricedAsset = 'bitcoin' | 'ethereum' | 'solana';

type CoinGeckoPriceResponse = Partial<Record<DonationPricedAsset, { usd?: number }>>;

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd';
const CACHE_TTL_MS = 60_000;
const SOURCE_ID = 'donations-coingecko';

/**
 * USD prices for the only assets a donation quote needs to convert from a USD amount: BTC, ETH,
 * SOL. USDC/USDT are treated as 1:1 USD stablecoins by `DonationService` and never reach here.
 * A failed/rate-limited fetch degrades gracefully: the previous cached price is kept until it
 * succeeds again, or `null` if nothing was ever fetched — callers must hide the affected asset's
 * preset buttons rather than quote a stale-to-the-point-of-wrong amount.
 */
@Injectable()
export class DonationPriceService {
  private cache: Partial<Record<DonationPricedAsset, number>> = {};
  private cachedAt = 0;
  private pending: Promise<void> | null = null;

  async getUsdPrices(): Promise<Partial<Record<DonationPricedAsset, number>>> {
    const isFresh = Date.now() - this.cachedAt < CACHE_TTL_MS;
    if (!isFresh) {
      await this.refresh();
    }
    return this.cache;
  }

  private async refresh(): Promise<void> {
    if (this.pending) {
      await this.pending;
      return;
    }
    this.pending = this.fetchAndCache();
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async fetchAndCache(): Promise<void> {
    const result = await throttledFetchJson<CoinGeckoPriceResponse>(SOURCE_ID, COINGECKO_URL, {
      timeoutMs: 5000,
      maxRetries: 1,
      minIntervalMs: 15000,
    });
    if (result.data == null) {
      // Keep whatever was cached before — a rate-limited/offline CoinGecko must not wipe a
      // still-usable last known price, nor block the donation widget from rendering.
      return;
    }
    const next: Partial<Record<DonationPricedAsset, number>> = {};
    (['bitcoin', 'ethereum', 'solana'] as const).forEach((asset) => {
      const price = result.data?.[asset]?.usd;
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
        next[asset] = price;
      }
    });
    this.cache = { ...this.cache, ...next };
    this.cachedAt = Date.now();
  }
}
