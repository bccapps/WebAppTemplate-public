/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ModuleConfigSchema } from './types/ModuleConfigSchema';

/**
 * Donation widget (`DonateButton`/`DonationDialog`) configuration — non-custodial, no payment
 * tracking. Every field is `hidden: true`: the generic `ModuleConfigForm` never renders them,
 * `AdminDonations.tsx` is the only UI that reads/writes this schema's keys (via the existing
 * `/admin/module-configs/common` endpoint, no dedicated admin endpoint needed).
 */
export const donationsConfigSchema: ModuleConfigSchema = {
  moduleId: 'common',
  moduleName: 'Common',
  description: 'Donation widget configuration',
  fields: [
    {
      key: 'donations_enabledMethods',
      label: 'common.donations.enabledMethods',
      description: 'common.donations.enabledMethods.description',
      type: 'multiselect',
      defaultValue: [],
      group: 'donations',
      hidden: true,
      options: [
        { value: 'bitcoin', label: 'common.donations.method.bitcoin' },
        { value: 'evm', label: 'common.donations.method.evm' },
        { value: 'solana', label: 'common.donations.method.solana' },
        { value: 'stripe', label: 'common.donations.method.stripe' },
        { value: 'paypal', label: 'common.donations.method.paypal' },
      ],
    },
    {
      key: 'donations_presetAmountsUsd',
      label: 'common.donations.presetAmountsUsd',
      description: 'common.donations.presetAmountsUsd.description',
      type: 'json',
      defaultValue: [1, 5, 10],
      group: 'donations',
      hidden: true,
    },
    {
      key: 'donations_bitcoinAddress',
      label: 'common.donations.bitcoinAddress',
      description: 'common.donations.bitcoinAddress.description',
      type: 'string',
      defaultValue: '',
      group: 'donations',
      hidden: true,
    },
    {
      key: 'donations_evmAddress',
      label: 'common.donations.evmAddress',
      description: 'common.donations.evmAddress.description',
      type: 'string',
      defaultValue: '',
      group: 'donations',
      hidden: true,
    },
    {
      key: 'donations_evmChains',
      label: 'common.donations.evmChains',
      description: 'common.donations.evmChains.description',
      type: 'multiselect',
      defaultValue: ['ethereum', 'bsc', 'base', 'arbitrum'],
      group: 'donations',
      hidden: true,
      options: [
        { value: 'ethereum', label: 'common.donations.chain.ethereum' },
        { value: 'bsc', label: 'common.donations.chain.bsc' },
        { value: 'base', label: 'common.donations.chain.base' },
        { value: 'arbitrum', label: 'common.donations.chain.arbitrum' },
      ],
    },
    {
      key: 'donations_evmAssets',
      label: 'common.donations.evmAssets',
      description: 'common.donations.evmAssets.description',
      type: 'multiselect',
      defaultValue: ['ETH', 'USDC', 'USDT'],
      group: 'donations',
      hidden: true,
      options: [
        { value: 'ETH', label: 'common.donations.asset.eth' },
        { value: 'USDC', label: 'common.donations.asset.usdc' },
        { value: 'USDT', label: 'common.donations.asset.usdt' },
      ],
    },
    {
      key: 'donations_solanaAddress',
      label: 'common.donations.solanaAddress',
      description: 'common.donations.solanaAddress.description',
      type: 'string',
      defaultValue: '',
      group: 'donations',
      hidden: true,
    },
    {
      key: 'donations_solanaAssets',
      label: 'common.donations.solanaAssets',
      description: 'common.donations.solanaAssets.description',
      type: 'multiselect',
      defaultValue: ['SOL', 'USDC'],
      group: 'donations',
      hidden: true,
      options: [
        { value: 'SOL', label: 'common.donations.asset.sol' },
        { value: 'USDC', label: 'common.donations.asset.usdc' },
      ],
    },
    {
      key: 'donations_stripeSecretKey',
      label: 'common.donations.stripeSecretKey',
      description: 'common.donations.stripeSecretKey.description',
      type: 'secret',
      defaultValue: '',
      group: 'donations',
      hidden: true,
    },
    {
      key: 'donations_paypalMeUsername',
      label: 'common.donations.paypalMeUsername',
      description: 'common.donations.paypalMeUsername.description',
      type: 'string',
      defaultValue: '',
      group: 'donations',
      hidden: true,
    },
  ],
};
