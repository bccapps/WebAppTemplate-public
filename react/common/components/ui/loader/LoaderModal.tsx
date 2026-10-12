/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Box, CircularProgress, Modal, Typography } from '@mui/material';
import { i18n } from '../../../core/i18n/I18n';

export interface LoaderModalProps {
  message?: string;
  open?: boolean;
}

export const LoaderModal = ({ message = i18n.get('common.loading'), open = true }: LoaderModalProps) => {
  return (
    <Modal
      open={open}
      aria-busy="true"
      aria-live="polite"
      slotProps={{
        backdrop: {
          sx: {
            backdropFilter: 'blur(8px)',
            backgroundColor: 'rgba(0, 0, 0, 0.35)',
          },
        },
      }}
    >
      <Box
        sx={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 2,
        }}
      >
        <Box
          sx={{
            minWidth: 280,
            maxWidth: '90vw',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            p: 3,
            borderRadius: 2,
            bgcolor: 'background.paper',
            boxShadow: (theme) => theme.shadows[8],
          }}
        >
          <Typography variant="body1">{message}</Typography>
          <CircularProgress size={32} />
        </Box>
      </Box>
    </Modal>
  );
};
