/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Dialog, DialogContent, DialogTitle, IconButton, Tab, Tabs } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { i18n } from '../../../core/i18n/I18n';
import { useDonationConfig } from '../../../hooks/useDonationConfig';
import { AmountPicker } from './AmountPicker';
import { CryptoPayPanel, CryptoChainOption } from './CryptoPayPanel';
import { StripePanel } from './StripePanel';
import { PaypalPanel } from './PaypalPanel';
import type { DonationQuoteAsset } from '../../../services/donationApi';

export interface DonationDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Amount selector + one tab per payment method the admin enabled and configured. */
export const DonationDialog = ({ open, onClose }: DonationDialogProps) => {
  const { status, config } = useDonationConfig();
  const [amountUsd, setAmountUsd] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<string>('');

  useEffect(() => {
    if (status === 'ready' && config && amountUsd === null) {
      const presets = config.presetAmountsUsd.length > 0 ? config.presetAmountsUsd : [1, 5, 10];
      setAmountUsd(presets[0]);
    }
  }, [status, config, amountUsd]);

  const tabs = useMemo(() => {
    if (!config) return [];
    const list: { key: string; label: string }[] = [];
    if (config.bitcoin) list.push({ key: 'bitcoin', label: i18n.get('common.donations.method.bitcoin') });
    if (config.evm) list.push({ key: 'evm', label: i18n.get('common.donations.method.evm') });
    if (config.solana) list.push({ key: 'solana', label: i18n.get('common.donations.method.solana') });
    if (config.stripe) list.push({ key: 'stripe', label: i18n.get('common.donations.method.stripe') });
    if (config.paypal) list.push({ key: 'paypal', label: i18n.get('common.donations.method.paypal') });
    return list;
  }, [config]);

  const currentTab = tabs.some((t) => t.key === activeTab) ? activeTab : (tabs[0]?.key ?? '');

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>
        {i18n.get('common.donations.dialogTitle')}
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        {status === 'loading' && <Box sx={{ py: 3, textAlign: 'center' }}>…</Box>}
        {status === 'error' && <Alert severity="error">{i18n.get('common.donations.config.error')}</Alert>}
        {status === 'ready' && config && tabs.length === 0 && (
          <Alert severity="info">{i18n.get('common.donations.noMethodConfigured')}</Alert>
        )}
        {status === 'ready' && config && tabs.length > 0 && amountUsd !== null && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <AmountPicker presets={config.presetAmountsUsd.length > 0 ? config.presetAmountsUsd : [1, 5, 10]} value={amountUsd} onChange={setAmountUsd} />
            <Tabs value={currentTab} onChange={(_, v) => setActiveTab(v)} variant="scrollable" scrollButtons="auto">
              {tabs.map((t) => (
                <Tab key={t.key} value={t.key} label={t.label} />
              ))}
            </Tabs>
            {currentTab === 'bitcoin' && config.bitcoin && (
              <CryptoPayPanel amountUsd={amountUsd} address={config.bitcoin.address} chains={[{ chain: 'bitcoin', label: 'Bitcoin' }]} assets={['BTC']} />
            )}
            {currentTab === 'evm' && config.evm && (
              <CryptoPayPanel
                amountUsd={amountUsd}
                address={config.evm.address}
                chains={config.evm.chains.map<CryptoChainOption>((c) => ({ chain: c.id, label: c.label }))}
                assets={config.evm.assets as DonationQuoteAsset[]}
              />
            )}
            {currentTab === 'solana' && config.solana && (
              <CryptoPayPanel
                amountUsd={amountUsd}
                address={config.solana.address}
                chains={[{ chain: 'solana', label: 'Solana' }]}
                assets={config.solana.assets as DonationQuoteAsset[]}
              />
            )}
            {currentTab === 'stripe' && config.stripe && <StripePanel amountUsd={amountUsd} />}
            {currentTab === 'paypal' && config.paypal && <PaypalPanel username={config.paypal.username} amountUsd={amountUsd} />}
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
};
