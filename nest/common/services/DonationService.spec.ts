/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

const checkoutSessionsCreate: jest.Mock<(...args: any[]) => Promise<{ url: string | null }>> = jest.fn();
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ checkout: { sessions: { create: checkoutSessionsCreate } } })),
}));

import { DonationService } from './DonationService';
import type { ModuleConfigService } from './ModuleConfigService';
import type { DonationPriceService } from './DonationPriceService';

const DEFAULT_VALUES: Record<string, unknown> = {
  donations_enabledMethods: ['bitcoin', 'evm', 'solana', 'stripe', 'paypal'],
  donations_presetAmountsUsd: [1, 5, 10],
  donations_bitcoinAddress: 'bc1qxyz',
  donations_evmAddress: '0xabc',
  donations_evmChains: ['ethereum', 'base'],
  donations_evmAssets: ['ETH', 'USDC', 'USDT'],
  donations_solanaAddress: 'SoLAddr',
  donations_solanaAssets: ['SOL', 'USDC'],
  donations_paypalMeUsername: 'myuser',
};

function makeModuleConfigService(values: Record<string, unknown> = {}, stripeSecretSet = true): ModuleConfigService {
  const merged = { ...DEFAULT_VALUES, ...values };
  return {
    getResolvedValue: (key: string) => merged[key],
    getDecryptedSecretValue: (_moduleId: string, key: string) => (key === 'donations_stripeSecretKey' && stripeSecretSet ? 'sk_test_x' : null),
  } as unknown as ModuleConfigService;
}

function makePriceService(prices: Partial<Record<'bitcoin' | 'ethereum' | 'solana', number>>): DonationPriceService {
  return { getUsdPrices: async () => prices } as unknown as DonationPriceService;
}

describe('DonationService.getPublicConfig', () => {
  it('only exposes a method that is both enabled and has its address/username configured', async () => {
    const service = new DonationService(makeModuleConfigService({ donations_enabledMethods: ['bitcoin', 'stripe'] }), makePriceService({}));
    const config = await service.getPublicConfig();
    expect(config.bitcoin).toEqual({ address: 'bc1qxyz' });
    expect(config.evm).toBeNull();
    expect(config.solana).toBeNull();
    expect(config.paypal).toBeNull();
    expect(config.stripe).toEqual({ enabled: true });
  });

  it('hides a method enabled by the admin but missing its required address', async () => {
    const service = new DonationService(makeModuleConfigService({ donations_enabledMethods: ['bitcoin'], donations_bitcoinAddress: '' }), makePriceService({}));
    const config = await service.getPublicConfig();
    expect(config.bitcoin).toBeNull();
  });

  it('never exposes the Stripe secret value, only whether one is set', async () => {
    const service = new DonationService(makeModuleConfigService({ donations_enabledMethods: ['stripe'] }, false), makePriceService({}));
    const config = await service.getPublicConfig();
    expect(config.stripe).toBeNull();
    expect(JSON.stringify(config)).not.toContain('sk_test');
  });
});

describe('DonationService.getQuote', () => {
  it('computes a BIP21 Bitcoin URI from the live BTC price', async () => {
    const service = new DonationService(makeModuleConfigService(), makePriceService({ bitcoin: 50000 }));
    const quote = await service.getQuote('bitcoin', 'BTC', 10);
    expect(quote.amount).toBe('0.00020000');
    expect(quote.uri).toBe('bitcoin:bc1qxyz?amount=0.0002');
  });

  it('computes an EIP-681 URI in wei for native ETH', async () => {
    const service = new DonationService(makeModuleConfigService(), makePriceService({ ethereum: 2000 }));
    const quote = await service.getQuote('ethereum', 'ETH', 10);
    expect(quote.amount).toBe('0.00500000');
    expect(quote.uri).toBe('ethereum:0xabc@1?value=5000000000000000');
  });

  it('computes an ERC-20 transfer URI in base units for a 1:1 stablecoin, no price lookup needed', async () => {
    const service = new DonationService(makeModuleConfigService(), makePriceService({}));
    const quote = await service.getQuote('base', 'USDC', 10);
    expect(quote.amount).toBe('10.000000');
    expect(quote.uri).toBe('ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=0xabc&uint256=10000000');
  });

  it('computes a Solana Pay URI for SOL and for SPL USDC', async () => {
    const service = new DonationService(makeModuleConfigService(), makePriceService({ solana: 100 }));
    const sol = await service.getQuote('solana', 'SOL', 10);
    expect(sol.uri).toBe('solana:SoLAddr?amount=0.1');
    const usdc = await service.getQuote('solana', 'USDC', 10);
    expect(usdc.uri).toBe('solana:SoLAddr?amount=10&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('rejects a chain/asset combination that makes no sense', async () => {
    const service = new DonationService(makeModuleConfigService(), makePriceService({}));
    await expect(service.getQuote('bitcoin', 'ETH', 10)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a quote when the required live price is unavailable', async () => {
    const service = new DonationService(makeModuleConfigService(), makePriceService({}));
    await expect(service.getQuote('bitcoin', 'BTC', 10)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('refuses a quote for a chain/asset the admin did not enable, even though the address is configured', async () => {
    const service = new DonationService(makeModuleConfigService({ donations_evmChains: ['base'], donations_evmAssets: ['USDC'] }), makePriceService({}));
    await expect(service.getQuote('ethereum', 'USDC', 10)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getQuote('base', 'USDT', 10)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a quote for a method the admin never configured an address for', async () => {
    const service = new DonationService(makeModuleConfigService({ donations_bitcoinAddress: '' }), makePriceService({ bitcoin: 50000 }));
    await expect(service.getQuote('bitcoin', 'BTC', 10)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('DonationService.createStripeCheckoutSession', () => {
  it('creates a Checkout session for the USD amount and returns its URL', async () => {
    checkoutSessionsCreate.mockReset();
    checkoutSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_test_x' });
    const service = new DonationService(makeModuleConfigService(), makePriceService({}));
    const result = await service.createStripeCheckoutSession({ amountUsd: 5, successUrl: 'https://app/success', cancelUrl: 'https://app/cancel' });
    expect(result).toEqual({ url: 'https://checkout.stripe.com/pay/cs_test_x' });
    expect(checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ success_url: 'https://app/success', cancel_url: 'https://app/cancel' }),
    );
  });

  it('refuses to create a session when no Stripe secret key is configured', async () => {
    const service = new DonationService(makeModuleConfigService({}, false), makePriceService({}));
    await expect(service.createStripeCheckoutSession({ amountUsd: 5, successUrl: 'https://a', cancelUrl: 'https://b' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
