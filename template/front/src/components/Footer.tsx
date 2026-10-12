/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Typography, Box, Link as MuiLink, Stack } from '@mui/material';
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';
import { Link as RouterLink } from 'react-router-dom';

export function Footer() {
  return (
    <Box
      className="Footer"
      sx={{
        width: '100%',
        py: 3,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          <I18nLabel id="custom.app.footer" />
        </Typography>
        <MuiLink
          component={RouterLink}
          to="/legal-mentions"
          variant="body2"
          sx={{
            color: 'text.secondary',
            textDecoration: 'none',
            '&:hover': { textDecoration: 'underline' },
          }}
        >
          <I18nLabel id="common.app.footer.legal" />
        </MuiLink>
        <MuiLink
          component={RouterLink}
          to="/confidentiality"
          variant="body2"
          sx={{
            color: 'text.secondary',
            textDecoration: 'none',
            '&:hover': { textDecoration: 'underline' },
          }}
        >
          <I18nLabel id="common.app.footer.confidentiality" />
        </MuiLink>
        <MuiLink
          component={RouterLink}
          to="/usage-conditions"
          variant="body2"
          sx={{
            color: 'text.secondary',
            textDecoration: 'none',
            '&:hover': { textDecoration: 'underline' },
          }}
        >
          <I18nLabel id="common.app.footer.usage" />
        </MuiLink>
      </Stack>
    </Box>
  );
}
