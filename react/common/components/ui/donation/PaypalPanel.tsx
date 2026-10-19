/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Button, Stack } from '@mui/material';
import { i18n } from '../../../core/i18n/I18n';

export interface PaypalPanelProps {
  username: string;
  amountUsd: number;
}

/** Pure link-out to paypal.me — no backend call, no tracking. */
export const PaypalPanel = ({ username, amountUsd }: PaypalPanelProps) => {
  const pay = () => {
    const url = `https://paypal.me/${encodeURIComponent(username)}/${amountUsd}USD`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
      <Button variant="contained" onClick={pay}>
        {i18n.get('common.donations.paypal.pay', [String(amountUsd)])}
      </Button>
    </Stack>
  );
};
