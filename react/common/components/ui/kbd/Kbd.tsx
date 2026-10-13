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

/** A keyboard shortcut hint (`<kbd>`), e.g. `<Kbd>Ctrl+K</Kbd>`. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <Box
      component="kbd"
      sx={{
        px: 0.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 0.5,
        bgcolor: 'action.hover',
        color: 'text.secondary',
        fontFamily: 'monospace',
        fontSize: 10,
        lineHeight: 1.4,
      }}
    >
      {children}
    </Box>
  );
}
