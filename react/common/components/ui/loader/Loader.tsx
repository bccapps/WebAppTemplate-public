/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import '../../../styles/tokens.css';
import { Box, Typography } from '@mui/material';
import { i18n } from '../../../core/i18n/I18n';
import { useThemeImage } from '../../../theme/hooks/useThemeImage';

export interface ILoaderProps {
  size?: number;
  label?: string;
  logoSrc?: string;
}

export const Loader = ({ size = 96, label = i18n.get('common.loading'), logoSrc }: ILoaderProps) => {
  const themeLogo = useThemeImage('logoMain');
  const ringSize = size + 20;

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: '1.25rem',
        zIndex: 9999,
      }}
      role="status"
      aria-label={i18n.get('common.loading')}
    >
      <Box
        sx={{
          position: 'relative',
          width: ringSize,
          height: ringSize,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Box
          component="img"
          src={logoSrc ?? themeLogo}
          alt=""
          sx={{
            width: size,
            height: size,
            borderRadius: '50%',
            position: 'relative',
            zIndex: 1,
            animation: 'loaderPulse 2s ease-in-out infinite',
            '@keyframes loaderPulse': {
              '0%, 100%': { opacity: 0.85, transform: 'scale(1)' },
              '50%': { opacity: 1, transform: 'scale(1.06)' },
            },
          }}
        />
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: '2.5px solid transparent',
            borderTopColor: 'var(--common-loader-spinner)',
            animation: 'loaderSpin 1s linear infinite',
            '@keyframes loaderSpin': {
              to: { transform: 'rotate(360deg)' },
            },
          }}
        />
      </Box>
      {label && (
        <Typography
          variant="body2"
          sx={{
            opacity: 0.55,
            fontSize: '0.8rem',
            letterSpacing: '0.03em',
          }}
        >
          {label}
        </Typography>
      )}
    </Box>
  );
};
