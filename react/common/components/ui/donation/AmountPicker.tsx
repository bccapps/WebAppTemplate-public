/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useState } from 'react';
import { Stack, Button, TextField } from '@mui/material';
import { i18n } from '../../../core/i18n/I18n';
import { parseAmountInput } from './amountInput';

export interface AmountPickerProps {
  presets: number[];
  value: number;
  onChange: (amountUsd: number) => void;
}

/**
 * Preset "$1 / $5 / $10 / ..." buttons plus a free-text USD amount — either one sets `value`.
 */
export const AmountPicker = ({ presets, value, onChange }: AmountPickerProps) => {
  const [customText, setCustomText] = useState('');

  const selectPreset = (amount: number) => {
    setCustomText('');
    onChange(amount);
  };

  const onCustomChange = (text: string) => {
    setCustomText(text);
    const parsed = parseAmountInput(text);
    if (parsed !== null) onChange(parsed);
  };

  const isInvalidCustom = customText.trim() !== '' && parseAmountInput(customText) === null;

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {presets.map((amount) => (
          <Button
            key={amount}
            variant={customText === '' && value === amount ? 'contained' : 'outlined'}
            onClick={() => selectPreset(amount)}
          >
            ${amount}
          </Button>
        ))}
      </Stack>
      <TextField
        size="small"
        type="text"
        inputMode="decimal"
        label={i18n.get('common.donations.customAmount')}
        value={customText}
        onChange={(e) => onCustomChange(e.target.value)}
        error={isInvalidCustom}
        helperText={isInvalidCustom ? i18n.get('common.donations.customAmount.invalid') : undefined}
      />
    </Stack>
  );
};
