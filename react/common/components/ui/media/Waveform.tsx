/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { useId, useMemo } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Box, keyframes } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { i18n } from '../../../core/i18n/I18n';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { fractionInBox, seekFractionForKey } from './audioMath';

export interface WaveformProps {
  /** Bar heights, each 0..1 (see `computePeaks`). Empty shows a flat line. */
  peaks: number[];
  /** Played part, 0..1. */
  progress?: number;
  /** Click, drag or keyboard (arrows, Page, Home, End) on the waveform: position 0..1. Omit for a read-only waveform. */
  onSeek?: (fraction: number) => void;
  /** Minimum bar height (0..1) so quiet parts stay visible. */
  floor?: number;
  /** Adds a soft glow to the played part (while playing). */
  active?: boolean;
  /** Keyboard step as a fraction of the duration. */
  keyboardStep?: number;
  height?: number | string;
}

const VIEW_HEIGHT = 40;

/** Bar waveform: a muted layer plus a highlighted layer clipped to `progress`. */
export function Waveform({ peaks, progress = 0, onSeek, floor = 0.07, active = false, keyboardStep = 0.05, height = 48 }: WaveformProps) {
  useI18nVersion();
  const clip = `wf${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const n = Math.max(1, peaks.length);
  const bars = useMemo(
    () =>
      peaks.length === 0 ? (
        <rect x={0} y={VIEW_HEIGHT / 2 - 0.5} width={n} height={1} />
      ) : (
        peaks.map((p, i) => {
          const h = Math.max(floor, Math.min(1, p)) * 34;
          return <rect key={i} x={i + 0.18} y={VIEW_HEIGHT / 2 - h / 2} width={0.64} height={h} rx={0.32} />;
        })
      ),
    [peaks, floor, n],
  );
  const safeProgress = Math.max(0, Math.min(1, progress));

  const seekFromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek?.(fractionInBox(e.clientX, rect.left, rect.width));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = seekFractionForKey(safeProgress, e.key, keyboardStep);
    if (next === null) return;
    e.preventDefault();
    onSeek?.(next);
  };

  return (
    <Box
      role={onSeek ? 'slider' : 'img'}
      tabIndex={onSeek ? 0 : undefined}
      aria-label={i18n.get('common.ui.media.waveform.position')}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? 100 : undefined}
      aria-valuenow={onSeek ? Math.round(safeProgress * 100) : undefined}
      onPointerDown={
        onSeek
          ? (e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              seekFromPointer(e);
            }
          : undefined
      }
      onPointerMove={onSeek ? (e) => e.buttons === 1 && seekFromPointer(e) : undefined}
      onKeyDown={onSeek ? onKeyDown : undefined}
      sx={(theme) => ({
        position: 'relative',
        height,
        minWidth: 0,
        userSelect: 'none',
        touchAction: onSeek ? 'none' : undefined,
        cursor: onSeek ? 'pointer' : 'default',
        borderRadius: 1,
        outline: 'none',
        '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
        '& svg': { display: 'block', width: '100%', height: '100%' },
        '& .wf-base': { fill: alpha(theme.palette.text.secondary, 0.45) },
        '& .wf-played': {
          fill: theme.palette.primary.main,
          filter: active ? `drop-shadow(0 0 3px ${alpha(theme.palette.primary.main, 0.7)})` : undefined,
        },
      })}
    >
      <svg viewBox={`0 0 ${n} ${VIEW_HEIGHT}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <clipPath id={clip}>
            <rect x={0} y={0} width={n * safeProgress} height={VIEW_HEIGHT} />
          </clipPath>
        </defs>
        <g className="wf-base">{bars}</g>
        <g className="wf-played" clipPath={`url(#${clip})`}>
          {bars}
        </g>
      </svg>
    </Box>
  );
}

const breathe = keyframes`
  0%, 100% { opacity: 0.45; transform: scaleY(0.85); }
  50% { opacity: 1; transform: scaleY(1); }
`;

export interface WaveformPendingProps {
  /** Completed part, 0..1 (e.g. synthesis progress). */
  fraction?: number;
  /** Animates the bars (disabled by `prefers-reduced-motion`). */
  active?: boolean;
  bars?: number;
  height?: number | string;
}

/** Placeholder waveform with animated bars while the real profile is not known yet. */
export function WaveformPending({ fraction = 0, active = true, bars = 72, height = 48 }: WaveformPendingProps) {
  useI18nVersion();
  return (
    <Box
      role="progressbar"
      aria-label={i18n.get('common.ui.progress.label')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.max(0, Math.min(1, fraction)) * 100)}
      sx={(theme) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '3px',
        height,
        '& span': {
          flex: 1,
          minWidth: '1px',
          borderRadius: 999,
          backgroundColor: alpha(theme.palette.text.secondary, 0.35),
          ...(active && {
            animation: `${breathe} 1.6s ease-in-out infinite`,
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
          }),
        },
        '& span.done': { backgroundColor: theme.palette.primary.main },
      })}
    >
      {Array.from({ length: bars }, (_, i) => {
        const base = 0.25 + 0.55 * Math.abs(Math.sin(i * 0.61) * Math.cos(i * 0.23));
        return (
          <span
            key={i}
            className={i / bars < fraction ? 'done' : undefined}
            style={{ height: `${base * 100}%`, animationDelay: `${(i % 12) * 90}ms` }}
          />
        );
      })}
    </Box>
  );
}
