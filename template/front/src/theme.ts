/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { createTheme } from '@mui/material/styles';

// Neutral starter palette — customize per project (see README "Needed Customizations").
export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#3B82F6',
    },
    secondary: {
      main: '#8B5CF6',
    },
    background: {
      default: '#121212',
      paper: '#1E1E1E',
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: '#121212',
        },
      },
    },
  },
});
