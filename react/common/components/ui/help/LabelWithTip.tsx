/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ReactNode } from 'react';
import { Box } from '@mui/material';
import { InfoTip } from './InfoTip';
import type { Help } from './helpText';

/** A label followed by its `InfoTip` (omitted when no help is given). */
export function LabelWithTip({ children, help, className }: { children: ReactNode; help?: Help; className?: string }) {
  return (
    <Box component="span" className={className} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
      {children}
      {help && <InfoTip {...help} />}
    </Box>
  );
}
