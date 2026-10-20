/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import '../../../styles/tokens.css';
import { useEffect, useState } from 'react';
import { Alert, Box, CircularProgress, IconButton, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { QRCodeSVG } from 'qrcode.react';
import { i18n } from '../../../core/i18n/I18n';
import { toastService } from '../../../core/toast/ToastService';
import { donationApi, DonationQuoteAsset, DonationQuoteChain, DonationQuoteResult } from '../../../services/donationApi';

export interface CryptoChainOption {
  chain: DonationQuoteChain;
  label: string;
}

export interface CryptoPayPanelProps {
  amountUsd: number;
  address: string;
  chains: CryptoChainOption[];
  assets: DonationQuoteAsset[];
}

const copyToClipboard = (text: string, successKey: string) => {
  navigator.clipboard
    .writeText(text)
    .then(() => toastService.success(successKey))
    .catch(() => toastService.error('common.donations.copy.error'));
};

/** One tab's payment panel for Bitcoin, an EVM chain, or Solana — address + QR + copy, no tracking. */
export const CryptoPayPanel = ({ amountUsd, address, chains, assets }: CryptoPayPanelProps) => {
  const [chain, setChain] = useState<DonationQuoteChain>(chains[0].chain);
  const [asset, setAsset] = useState<DonationQuoteAsset>(assets[0]);
  const [quote, setQuote] = useState<DonationQuoteResult | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    donationApi
      .getQuote(chain, asset, amountUsd)
      .then((result) => {
        if (!cancelled) setQuote(result);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chain, asset, amountUsd]);

  return (
    <Stack spacing={2}>
      {chains.length > 1 && (
        <ToggleButtonGroup size="small" exclusive value={chain} onChange={(_, v) => v && setChain(v)}>
          {chains.map((c) => (
            <ToggleButton key={c.chain} value={c.chain}>
              {c.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      )}
      {assets.length > 1 && (
        <ToggleButtonGroup size="small" exclusive value={asset} onChange={(_, v) => v && setAsset(v)}>
          {assets.map((a) => (
            <ToggleButton key={a} value={a}>
              {a}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      )}

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={28} />
        </Box>
      )}
      {!loading && loadError && <Alert severity="warning">{i18n.get('common.donations.quote.error')}</Alert>}

      {!loading && !loadError && quote && (
        <Stack spacing={1.5} sx={{ alignItems: 'center' }}>
          <Box sx={{ bgcolor: 'var(--common-cryptopay-qr-bg)', p: 1.5, borderRadius: 1 }}>
            <QRCodeSVG value={quote.uri} size={180} />
          </Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%' }}>
            <TextField size="small" fullWidth label={i18n.get('common.donations.address')} value={address} slotProps={{ input: { readOnly: true } }} />
            <IconButton onClick={() => copyToClipboard(address, 'common.donations.copy.address.success')} title={i18n.get('common.donations.copy')}>
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%' }}>
            <TextField
              size="small"
              fullWidth
              label={i18n.get('common.donations.amountToSend', [asset])}
              value={quote.amount}
              slotProps={{ input: { readOnly: true } }}
            />
            <IconButton onClick={() => copyToClipboard(quote.amount, 'common.donations.copy.amount.success')} title={i18n.get('common.donations.copy')}>
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {i18n.get('common.donations.noTrackingNotice')}
          </Typography>
        </Stack>
      )}
    </Stack>
  );
};
