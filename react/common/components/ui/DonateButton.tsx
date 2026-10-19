/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useState } from 'react';
import { Button, ButtonProps, IconButton, Tooltip } from '@mui/material';
import FavoriteIcon from '@mui/icons-material/Favorite';
import { i18n } from '../../core/i18n/I18n';
import { DonationDialog } from './donation/DonationDialog';

export type DonateButtonProps = Omit<ButtonProps, 'onClick'> & {
  /** Icon-only button with a tooltip instead of the labeled button — for a collapsed sidebar/toolbar. */
  compact?: boolean;
};

/**
 * Standalone, reusable "Donate" button — no `plugin.tsx`, no imposed placement. Drop it in a
 * footer, a header, or a dedicated page; it opens `DonationDialog` and otherwise needs nothing
 * from the app. Renders unconditionally — `DonationDialog` itself shows
 * `common.donations.noMethodConfigured` when the admin hasn't configured any method yet.
 */
export const DonateButton = ({ compact, ...props }: DonateButtonProps) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      {compact ? (
        <Tooltip title={i18n.get('common.donations.buttonLabel')}>
          <IconButton size={props.size} onClick={() => setOpen(true)}>
            <FavoriteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ) : (
        <Button variant="outlined" startIcon={<FavoriteIcon />} {...props} onClick={() => setOpen(true)}>
          {i18n.get('common.donations.buttonLabel')}
        </Button>
      )}
      <DonationDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
};
