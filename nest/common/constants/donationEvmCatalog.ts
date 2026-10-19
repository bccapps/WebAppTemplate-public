/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Static catalog of EVM chain ids and known USDC/USDT contract addresses, plus the Solana USDC
 * mint — the only data a donation quote needs beyond the admin-configured receiving address,
 * since the same EVM address is valid on every EVM chain.
 *
 * SECURITY (money-critical): these addresses were accurate to the author's knowledge at the time
 * this file was written (model knowledge cutoff January 2026) but are NOT fetched from, or
 * verified against, any live registry. Re-verify every address against an official block explorer
 * (etherscan.io, bscscan.com, basescan.org, arbiscan.io) or the issuer's own docs
 * (circle.com for USDC, tether.to for USDT) before relying on this file for a real transfer.
 * A wrong contract address here does not just fail — it can silently send a donor's funds
 * nowhere recoverable. Never add or change a value here without that re-verification.
 */
export type DonationEvmChainId = 'ethereum' | 'bsc' | 'base' | 'arbitrum';

export interface DonationEvmChainInfo {
  readonly chainId: number;
  readonly label: string;
  /** `null` means the asset is not offered on this chain (no verified contract address on file). */
  readonly tokenContracts: Readonly<Record<'USDC' | 'USDT', string | null>>;
}

export const DONATION_EVM_CHAINS: Readonly<Record<DonationEvmChainId, DonationEvmChainInfo>> = {
  ethereum: {
    chainId: 1,
    label: 'Ethereum',
    tokenContracts: {
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    },
  },
  bsc: {
    chainId: 56,
    label: 'BNB Smart Chain',
    tokenContracts: {
      USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      USDT: '0x55d398326f99059fF775485246999027B3197955',
    },
  },
  base: {
    chainId: 8453,
    label: 'Base',
    tokenContracts: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    },
  },
  arbitrum: {
    chainId: 42161,
    label: 'Arbitrum One',
    tokenContracts: {
      USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    },
  },
};

/** Every EVM-side stablecoin uses 6 decimals; ETH uses the standard 18. */
export const DONATION_EVM_DECIMALS: Readonly<Record<'ETH' | 'USDC' | 'USDT', number>> = {
  ETH: 18,
  USDC: 6,
  USDT: 6,
};

/** Solana mainnet-beta USDC mint — same re-verification warning as the EVM table above. */
export const DONATION_SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Solana amounts in a Solana Pay URI are UI decimal amounts, not base units — SOL uses 9 decimals for rounding only. */
export const DONATION_SOLANA_DECIMALS: Readonly<Record<'SOL' | 'USDC', number>> = {
  SOL: 9,
  USDC: 6,
};
