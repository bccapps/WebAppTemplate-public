/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../utils/throttledFetch', () => ({ throttledFetchJson: jest.fn() }));

const { throttledFetchJson } = jest.requireMock('../utils/throttledFetch') as {
  throttledFetchJson: jest.Mock<(...args: any[]) => Promise<{ data: unknown; stale: boolean; status: number; rateLimited: boolean }>>;
};

import { DonationPriceService } from './DonationPriceService';

describe('DonationPriceService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    throttledFetchJson.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches once and caches the three USD prices', async () => {
    throttledFetchJson.mockResolvedValue({
      data: { bitcoin: { usd: 50000 }, ethereum: { usd: 3000 }, solana: { usd: 150 } },
      stale: false,
      status: 200,
      rateLimited: false,
    });

    const service = new DonationPriceService();
    const first = await service.getUsdPrices();
    expect(first).toEqual({ bitcoin: 50000, ethereum: 3000, solana: 150 });

    const second = await service.getUsdPrices();
    expect(second).toEqual({ bitcoin: 50000, ethereum: 3000, solana: 150 });
    expect(throttledFetchJson).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known prices when a refresh fails after the cache goes stale', async () => {
    throttledFetchJson.mockResolvedValueOnce({
      data: { bitcoin: { usd: 50000 }, ethereum: { usd: 3000 }, solana: { usd: 150 } },
      stale: false,
      status: 200,
      rateLimited: false,
    });
    const service = new DonationPriceService();
    await service.getUsdPrices();

    jest.advanceTimersByTime(61_000);
    throttledFetchJson.mockResolvedValueOnce({ data: null, stale: true, status: 0, rateLimited: false });

    const afterFailedRefresh = await service.getUsdPrices();
    expect(afterFailedRefresh).toEqual({ bitcoin: 50000, ethereum: 3000, solana: 150 });
  });

  it('returns no prices when nothing was ever fetched successfully', async () => {
    throttledFetchJson.mockResolvedValue({ data: null, stale: true, status: 0, rateLimited: false });
    const service = new DonationPriceService();
    expect(await service.getUsdPrices()).toEqual({});
  });
});
