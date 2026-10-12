/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import * as React from 'react';
import { Stack, Typography } from '@mui/material';
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';

const Confidentiality: React.FC = () => {
  return (
    <Stack spacing={2}>
      <Typography variant="h3">
        Confidentiality page
      </Typography>
      <Typography variant="body1" color="text.secondary">
        <I18nLabel id="custom.legal.confidentiality.placeholder" />
      </Typography>
    </Stack>
  );
};

export default Confidentiality;
