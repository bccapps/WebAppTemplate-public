/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { ModuleConfigService } from './ModuleConfigService';
import { DonationPriceService } from './DonationPriceService';
import {
  DONATION_EVM_CHAINS,
  DONATION_EVM_DECIMALS,
  DONATION_SOLANA_DECIMALS,
  DONATION_SOLANA_USDC_MINT,
  DonationEvmChainId,
} from '../constants/donationEvmCatalog';
import type { DonationQuoteAsset, DonationQuoteChain } from '../dtos/DonationQuoteQueryDto';
import type { CreateStripeCheckoutDto } from '../dtos/CreateStripeCheckoutDto';

const EVM_CHAIN_IDS = Object.keys(DONATION_EVM_CHAINS) as DonationEvmChainId[];

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

/**
 * Non-custodial donation widget: builds a public, admin-driven config and payment
 * quotes (amount + wallet-ready URI). Never verifies or tracks whether a donation was
 * actually paid — by design (see the module README "Dons" section).
 */
@Injectable()
export class DonationService {
  constructor(
    private readonly moduleConfigService: ModuleConfigService,
    private readonly priceService: DonationPriceService,
  ) {}

  private value<T>(key: string): T {
    return this.moduleConfigService.getResolvedValue(key) as T;
  }

  async getPublicConfig(): Promise<DonationPublicConfig> {
    const enabledMethods = this.value<string[]>('donations_enabledMethods') ?? [];
    const bitcoinAddress = this.value<string>('donations_bitcoinAddress') ?? '';
    const evmAddress = this.value<string>('donations_evmAddress') ?? '';
    const evmChains = this.value<DonationEvmChainId[]>('donations_evmChains') ?? [];
    const evmAssets = this.value<string[]>('donations_evmAssets') ?? [];
    const solanaAddress = this.value<string>('donations_solanaAddress') ?? '';
    const solanaAssets = this.value<string[]>('donations_solanaAssets') ?? [];
    const paypalUsername = this.value<string>('donations_paypalMeUsername') ?? '';
    const stripeSecretSet = this.moduleConfigService.getDecryptedSecretValue('common', 'donations_stripeSecretKey');

    return {
      enabledMethods,
      presetAmountsUsd: this.value<number[]>('donations_presetAmountsUsd') ?? [1, 5, 10],
      bitcoin: enabledMethods.includes('bitcoin') && bitcoinAddress ? { address: bitcoinAddress } : null,
      evm:
        enabledMethods.includes('evm') && evmAddress
          ? {
              address: evmAddress,
              chains: evmChains
                .filter((id): id is DonationEvmChainId => EVM_CHAIN_IDS.includes(id as DonationEvmChainId))
                .map((id) => ({ id, chainId: DONATION_EVM_CHAINS[id].chainId, label: DONATION_EVM_CHAINS[id].label })),
              assets: evmAssets,
            }
          : null,
      solana: enabledMethods.includes('solana') && solanaAddress ? { address: solanaAddress, assets: solanaAssets } : null,
      stripe: enabledMethods.includes('stripe') && stripeSecretSet ? { enabled: true } : null,
      paypal: enabledMethods.includes('paypal') && paypalUsername ? { username: paypalUsername } : null,
    };
  }

  async getQuote(chain: DonationQuoteChain, asset: DonationQuoteAsset, amountUsd: number): Promise<DonationQuoteResult> {
    if (chain === 'bitcoin') {
      if (asset !== 'BTC') throw new BadRequestException('Bitcoin only accepts the BTC asset');
      const address = this.value<string>('donations_bitcoinAddress');
      if (!address) throw new BadRequestException('Bitcoin donations are not configured');
      const btcPrice = await this.priceOf('bitcoin');
      const amount = (amountUsd / btcPrice).toFixed(8);
      return { amount, uri: `bitcoin:${address}?amount=${trimDecimal(amount)}` };
    }

    if (chain === 'solana') {
      const address = this.value<string>('donations_solanaAddress');
      if (!address) throw new BadRequestException('Solana donations are not configured');
      const solanaAssets = this.value<string[]>('donations_solanaAssets') ?? [];
      if (!solanaAssets.includes(asset)) throw new BadRequestException(`${asset} is not enabled for Solana donations`);
      if (asset === 'SOL') {
        const solPrice = await this.priceOf('solana');
        const amount = (amountUsd / solPrice).toFixed(DONATION_SOLANA_DECIMALS.SOL);
        return { amount, uri: `solana:${address}?amount=${trimDecimal(amount)}` };
      }
      if (asset === 'USDC') {
        const amount = amountUsd.toFixed(DONATION_SOLANA_DECIMALS.USDC);
        return { amount, uri: `solana:${address}?amount=${trimDecimal(amount)}&spl-token=${DONATION_SOLANA_USDC_MINT}` };
      }
      throw new BadRequestException('Solana only accepts SOL or USDC');
    }

    if (EVM_CHAIN_IDS.includes(chain as DonationEvmChainId)) {
      const evmChainId = chain as DonationEvmChainId;
      const address = this.value<string>('donations_evmAddress');
      if (!address) throw new BadRequestException('EVM donations are not configured');
      const evmChains = this.value<DonationEvmChainId[]>('donations_evmChains') ?? [];
      if (!evmChains.includes(evmChainId)) throw new BadRequestException(`${evmChainId} is not an enabled EVM chain`);
      const evmAssets = this.value<string[]>('donations_evmAssets') ?? [];
      if (!evmAssets.includes(asset)) throw new BadRequestException(`${asset} is not an enabled EVM asset`);
      const chainInfo = DONATION_EVM_CHAINS[evmChainId];

      if (asset === 'ETH') {
        const ethPrice = await this.priceOf('ethereum');
        const amount = (amountUsd / ethPrice).toFixed(8);
        const base = toBaseUnitsBigInt(amount, DONATION_EVM_DECIMALS.ETH);
        return { amount, chainId: chainInfo.chainId, uri: `ethereum:${address}@${chainInfo.chainId}?value=${base.toString()}` };
      }
      if (asset === 'USDC' || asset === 'USDT') {
        const tokenContract = chainInfo.tokenContracts[asset];
        if (!tokenContract) throw new BadRequestException(`${asset} is not available on ${chainInfo.label}`);
        const amount = amountUsd.toFixed(DONATION_EVM_DECIMALS[asset]);
        const base = toBaseUnitsBigInt(amount, DONATION_EVM_DECIMALS[asset]);
        return {
          amount,
          chainId: chainInfo.chainId,
          uri: `ethereum:${tokenContract}@${chainInfo.chainId}/transfer?address=${address}&uint256=${base.toString()}`,
        };
      }
      throw new BadRequestException('EVM chains only accept ETH, USDC or USDT');
    }

    throw new BadRequestException(`Unsupported chain: ${chain}`);
  }

  async createStripeCheckoutSession(dto: CreateStripeCheckoutDto): Promise<{ url: string }> {
    const secretKey = this.moduleConfigService.getDecryptedSecretValue('common', 'donations_stripeSecretKey');
    if (!secretKey) throw new BadRequestException('Stripe donations are not configured');

    // Pinned: unpinned, the API version would follow every SDK major (it was the SDK 22 default).
    // @ts-ignore — apiVersion's type tracks the installed SDK's latest, not this pin.
    const stripe = new Stripe(secretKey, { apiVersion: '2026-08-26.dahlia' });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Donation' },
            unit_amount: Math.round(dto.amountUsd * 100),
          },
          quantity: 1,
        },
      ],
      success_url: dto.successUrl,
      cancel_url: dto.cancelUrl,
    });
    if (!session.url) throw new ServiceUnavailableException('Stripe did not return a checkout URL');
    return { url: session.url };
  }

  private async priceOf(asset: 'bitcoin' | 'ethereum' | 'solana'): Promise<number> {
    const prices = await this.priceService.getUsdPrices();
    const price = prices[asset];
    if (!price) throw new ServiceUnavailableException(`${asset} price is temporarily unavailable`);
    return price;
  }
}

/** Removes a BIP21/Solana-Pay amount's trailing zeros (and a trailing dot) — cosmetic only. */
function trimDecimal(amount: string): string {
  return amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount;
}

/**
 * Converts a decimal amount string (already rounded to `decimals` places by `toFixed`) into its
 * integer base-unit `bigint` representation, without ever multiplying a float by 10**decimals —
 * that loses precision past a handful of significant digits for 18-decimal ETH amounts.
 */
function toBaseUnitsBigInt(decimalAmount: string, decimals: number): bigint {
  const [intPart, fracPart = ''] = decimalAmount.split('.');
  const paddedFrac = fracPart.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(paddedFrac || '0');
}
