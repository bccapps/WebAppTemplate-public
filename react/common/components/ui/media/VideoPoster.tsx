/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { i18n } from '../../../core/i18n/I18n';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { formatClock } from '../progress/progressFormat';
import { posterAspectRatio } from './posterAspect';

export interface VideoPosterProps {
  /** Video file; a muted looping preview plays from it on hover or focus. */
  src: string;
  /** Poster image, also the fallback when the video cannot play. */
  poster: string;
  width?: number | null;
  height?: number | null;
  /** Seconds, shown in the corner badge. */
  durationSeconds?: number | null;
  /** Text under the poster on hover (already translated). */
  caption?: string | null;
  alt?: string;
  onOpen: () => void;
  /** Overlay controls (favorite, menu...) the caller owns; clicks do not open the clip. */
  overlay?: ReactNode;
}

/** Video thumbnail: poster image, hover/focus preview (muted, looping), duration badge. */
export function VideoPoster({ src, poster, width, height, durationSeconds, caption, alt = '', onOpen, overlay }: VideoPosterProps) {
  useI18nVersion();
  const [preview, setPreview] = useState(false);
  const [failed, setFailed] = useState(false);
  const showVideo = preview && !failed;
  return (
    <Box
      onMouseEnter={() => setPreview(true)}
      onMouseLeave={() => setPreview(false)}
      sx={(theme) => ({
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 2,
        aspectRatio: String(posterAspectRatio(width, height)),
        bgcolor: 'action.hover',
        boxShadow: `0 0 0 1px ${theme.palette.divider}`,
        '&:hover .vp-caption, &:focus-within .vp-caption': { opacity: 1 },
      })}
    >
      <Box
        component="button"
        type="button"
        onClick={onOpen}
        onFocus={() => setPreview(true)}
        onBlur={() => setPreview(false)}
        aria-label={i18n.get('common.ui.media.poster.open')}
        sx={{ position: 'absolute', inset: 0, p: 0, border: 0, bgcolor: 'transparent', cursor: 'pointer', display: 'block', width: '100%' }}
      >
        <Box component="img" src={poster} alt={alt} loading="lazy" sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        {showVideo && (
          <Box
            component="video"
            src={src}
            poster={poster}
            muted
            loop
            autoPlay
            playsInline
            preload="auto"
            onError={() => setFailed(true)}
            sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
      </Box>
      {!showVideo && (
        <Box sx={{ position: 'absolute', right: 8, bottom: 8, display: 'flex', alignItems: 'center', gap: 0.5, px: 0.75, py: 0.25, borderRadius: 1, bgcolor: 'rgba(0,0,0,0.55)', color: '#fff', pointerEvents: 'none' }}>
          <PlayArrowIcon sx={{ fontSize: 12 }} />
          <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.4 }}>
            {durationSeconds ? formatClock(durationSeconds) : i18n.get('common.ui.media.poster.video')}
          </Typography>
        </Box>
      )}
      {overlay}
      {caption && (
        <Box className="vp-caption" sx={{ position: 'absolute', insetInline: 0, bottom: 0, px: 1.5, pb: 1.25, pt: 4, opacity: 0, transition: 'opacity .15s', pointerEvents: 'none', background: 'linear-gradient(to top, rgba(0,0,0,0.75), transparent)', color: '#fff' }}>
          <Typography variant="caption" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.3 }}>
            {caption}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
