/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useState } from 'react';
import { Alert, Button, Stack } from '@mui/material';
import { i18n } from '../../../core/i18n/I18n';
import { donationApi } from '../../../services/donationApi';

export interface StripePanelProps {
  amountUsd: number;
}

/** Redirects to a Stripe-hosted Checkout session for card/Apple Pay/Google Pay donations. */
export const StripePanel = ({ amountUsd }: StripePanelProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const pay = () => {
    setLoading(true);
    setError(false);
    const here = window.location.href;
    donationApi
      .createStripeCheckoutSession({
        amountUsd,
        successUrl: `${here}${here.includes('?') ? '&' : '?'}donation=success`,
        cancelUrl: `${here}${here.includes('?') ? '&' : '?'}donation=cancelled`,
      })
      .then(({ url }) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  return (
    <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
      <Button variant="contained" onClick={pay} disabled={loading}>
        {i18n.get('common.donations.stripe.pay', [String(amountUsd)])}
      </Button>
      {error && <Alert severity="warning">{i18n.get('common.donations.stripe.error')}</Alert>}
    </Stack>
  );
};
