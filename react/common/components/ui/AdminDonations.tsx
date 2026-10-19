/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useState } from 'react';
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, FormGroup, Stack, TextField, Typography } from '@mui/material';
import { i18n } from '../../core/i18n/I18n';
import { moduleConfigService } from '../../services/ModuleConfigService';

const EVM_CHAINS = ['ethereum', 'bsc', 'base', 'arbitrum'] as const;
const EVM_ASSETS = ['ETH', 'USDC', 'USDT'] as const;
const SOLANA_ASSETS = ['SOL', 'USDC'] as const;
const METHODS = ['bitcoin', 'evm', 'solana', 'stripe', 'paypal'] as const;

interface DonationsFormValues {
  donations_enabledMethods: string[];
  donations_presetAmountsUsd: number[];
  donations_bitcoinAddress: string;
  donations_evmAddress: string;
  donations_evmChains: string[];
  donations_evmAssets: string[];
  donations_solanaAddress: string;
  donations_solanaAssets: string[];
  donations_stripeSecretKey: string;
  donations_paypalMeUsername: string;
}

const EMPTY_VALUES: DonationsFormValues = {
  donations_enabledMethods: [],
  donations_presetAmountsUsd: [1, 5, 10],
  donations_bitcoinAddress: '',
  donations_evmAddress: '',
  donations_evmChains: [...EVM_CHAINS],
  donations_evmAssets: [...EVM_ASSETS],
  donations_solanaAddress: '',
  donations_solanaAssets: [...SOLANA_ASSETS],
  donations_stripeSecretKey: '',
  donations_paypalMeUsername: '',
};

function toggleInArray(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * Admin screen for the donation widget: every `donations_*` field is `hidden: true` in
 * `donationsConfigSchema`, so the generic `ModuleConfigForm` never shows them — this is the
 * only UI that reads/writes them, through the existing `/admin/module-configs/common` endpoint.
 */
export const AdminDonations = () => {
  const [values, setValues] = useState<DonationsFormValues>(EMPTY_VALUES);
  const [stripeSecretIsSet, setStripeSecretIsSet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    moduleConfigService
      .getModuleConfig('common')
      .then((config) => {
        if (!config) return;
        setValues((prev) => ({
          ...prev,
          ...Object.fromEntries(Object.keys(prev).map((key) => [key, config.currentValues[key] ?? (prev as any)[key]])),
        }));
        setStripeSecretIsSet(config.secretsIsSet?.donations_stripeSecretKey ?? false);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  const save = () => {
    setSaving(true);
    setError(false);
    setSaved(false);
    moduleConfigService
      .updateModuleConfig('common', values)
      .then(() => setSaved(true))
      .catch(() => setError(true))
      .finally(() => setSaving(false));
  };

  if (loading) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  return (
    <Stack spacing={3} sx={{ maxWidth: 560 }}>
      <Typography variant="h6">{i18n.get('common.donations.admin.title')}</Typography>

      <Stack spacing={1}>
        <Typography variant="subtitle2">{i18n.get('common.donations.admin.enabledMethods')}</Typography>
        <FormGroup row>
          {METHODS.map((method) => (
            <FormControlLabel
              key={method}
              control={
                <Checkbox
                  checked={values.donations_enabledMethods.includes(method)}
                  onChange={() => setValues((v) => ({ ...v, donations_enabledMethods: toggleInArray(v.donations_enabledMethods, method) }))}
                />
              }
              label={i18n.get(`common.donations.method.${method}`)}
            />
          ))}
        </FormGroup>
      </Stack>

      <TextField
        label={i18n.get('common.donations.admin.presetAmountsUsd')}
        helperText={i18n.get('common.donations.admin.presetAmountsUsd.helper')}
        value={values.donations_presetAmountsUsd.join(', ')}
        onChange={(e) =>
          setValues((v) => ({
            ...v,
            donations_presetAmountsUsd: e.target.value
              .split(',')
              .map((s) => Number(s.trim()))
              .filter((n) => Number.isFinite(n) && n > 0),
          }))
        }
      />

      <TextField
        label={i18n.get('common.donations.bitcoinAddress')}
        value={values.donations_bitcoinAddress}
        onChange={(e) => setValues((v) => ({ ...v, donations_bitcoinAddress: e.target.value }))}
      />

      <Stack spacing={1}>
        <TextField
          label={i18n.get('common.donations.evmAddress')}
          value={values.donations_evmAddress}
          onChange={(e) => setValues((v) => ({ ...v, donations_evmAddress: e.target.value }))}
        />
        <Typography variant="caption">{i18n.get('common.donations.evmChains')}</Typography>
        <FormGroup row>
          {EVM_CHAINS.map((chain) => (
            <FormControlLabel
              key={chain}
              control={
                <Checkbox
                  checked={values.donations_evmChains.includes(chain)}
                  onChange={() => setValues((v) => ({ ...v, donations_evmChains: toggleInArray(v.donations_evmChains, chain) }))}
                />
              }
              label={i18n.get(`common.donations.chain.${chain}`)}
            />
          ))}
        </FormGroup>
        <Typography variant="caption">{i18n.get('common.donations.evmAssets')}</Typography>
        <FormGroup row>
          {EVM_ASSETS.map((asset) => (
            <FormControlLabel
              key={asset}
              control={
                <Checkbox
                  checked={values.donations_evmAssets.includes(asset)}
                  onChange={() => setValues((v) => ({ ...v, donations_evmAssets: toggleInArray(v.donations_evmAssets, asset) }))}
                />
              }
              label={asset}
            />
          ))}
        </FormGroup>
      </Stack>

      <Stack spacing={1}>
        <TextField
          label={i18n.get('common.donations.solanaAddress')}
          value={values.donations_solanaAddress}
          onChange={(e) => setValues((v) => ({ ...v, donations_solanaAddress: e.target.value }))}
        />
        <Typography variant="caption">{i18n.get('common.donations.solanaAssets')}</Typography>
        <FormGroup row>
          {SOLANA_ASSETS.map((asset) => (
            <FormControlLabel
              key={asset}
              control={
                <Checkbox
                  checked={values.donations_solanaAssets.includes(asset)}
                  onChange={() => setValues((v) => ({ ...v, donations_solanaAssets: toggleInArray(v.donations_solanaAssets, asset) }))}
                />
              }
              label={asset}
            />
          ))}
        </FormGroup>
      </Stack>

      <TextField
        type="password"
        label={i18n.get('common.donations.stripeSecretKey')}
        placeholder={stripeSecretIsSet ? i18n.get('common.config.secret.set') : undefined}
        value={values.donations_stripeSecretKey}
        onChange={(e) => setValues((v) => ({ ...v, donations_stripeSecretKey: e.target.value }))}
      />

      <TextField
        label={i18n.get('common.donations.paypalMeUsername')}
        value={values.donations_paypalMeUsername}
        onChange={(e) => setValues((v) => ({ ...v, donations_paypalMeUsername: e.target.value }))}
      />

      {error && <Alert severity="error">{i18n.get('common.donations.admin.saveError')}</Alert>}
      {saved && !error && <Alert severity="success">{i18n.get('common.donations.admin.saveSuccess')}</Alert>}

      <Button variant="contained" loading={saving} onClick={save} sx={{ alignSelf: 'flex-start' }}>
        {i18n.get('common.donations.admin.save')}
      </Button>
    </Stack>
  );
};
