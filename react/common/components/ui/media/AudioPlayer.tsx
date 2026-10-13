/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Menu, MenuItem, Typography } from '@mui/material';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CheckIcon from '@mui/icons-material/Check';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { TipIconButton } from '../iconbutton/TipIconButton';
import { formatClock } from '../progress/progressFormat';
import { Waveform } from './Waveform';
import { useSharedAudioPlayer } from './useSharedAudioPlayer';

export interface AudioPlayerProps {
  /** Unique id of the sound: two players with the same id show the same state. */
  id: string;
  url: string;
  /** Waveform peaks 0..1 (see `computePeaks`); empty shows a flat line. */
  peaks?: number[];
  /** Duration in seconds when known up front (otherwise read from the file). */
  duration?: number;
  /** Starts playing on mount (browsers may refuse without a user gesture: see `blocked`). */
  autoPlay?: boolean;
  /** Shorter waveform. */
  compact?: boolean;
  /** Playback speeds offered; pass an empty list to hide the speed menu. */
  rates?: number[];
  /** Extra content under the controls (labels, actions) — the caller owns it. */
  footer?: ReactNode;
  /** Called when an automatic play was refused by the browser. */
  onAutoPlayBlocked?: () => void;
}

const DEFAULT_RATES = [0.75, 1, 1.25, 1.5, 2];

/** Play/pause, waveform with seeking, elapsed/total clock and speed menu on the tab-wide shared player. */
export function AudioPlayer({ id, url, peaks = [], duration, autoPlay = false, compact = false, rates = DEFAULT_RATES, footer, onAutoPlayBlocked }: AudioPlayerProps) {
  useI18nVersion();
  const player = useSharedAudioPlayer(id, url);
  const total = duration ?? player.duration;
  const progress = player.current && total > 0 ? Math.min(1, player.time / total) : 0;
  const { play, blocked } = player;

  useEffect(() => {
    if (autoPlay) play();
    // Only on mount / when the sound changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, id, url]);
  useEffect(() => {
    if (blocked) onAutoPlayBlocked?.();
  }, [blocked, onAutoPlayBlocked]);

  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <TipIconButton
          labelId={player.playing ? 'common.ui.media.audio.pause' : 'common.ui.media.audio.play'}
          tone="default"
          active={player.playing}
          onClick={player.toggle}
          sx={{ width: 40, height: 40, borderRadius: '50%' }}
        >
          {player.playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
        </TipIconButton>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Waveform peaks={peaks} progress={progress} active={player.playing} onSeek={player.seek} height={compact ? 36 : 48} />
        </Box>
        <Typography variant="caption" sx={{ fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums', minWidth: 76, textAlign: 'right', color: 'text.secondary' }}>
          {formatClock(player.current ? player.time : 0)}
          <Box component="span" sx={{ color: 'text.disabled' }}>
            {' / '}
            {formatClock(total)}
          </Box>
        </Typography>
        {rates.length > 0 && <RateMenu rate={player.rate} rates={rates} onChange={player.setRate} />}
      </Box>
      {footer}
    </Box>
  );
}

function RateMenu({ rate, rates, onChange }: { rate: number; rates: number[]; onChange: (rate: number) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <TipIconButton labelId="common.ui.media.audio.rate" onClick={(e) => setAnchor(e.currentTarget)} sx={{ borderRadius: 1, px: 1, fontFamily: 'monospace', fontSize: 12 }}>
        {rate}×
      </TipIconButton>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        {rates.map((r) => (
          <MenuItem
            key={r}
            selected={r === rate}
            onClick={() => {
              onChange(r);
              setAnchor(null);
            }}
            sx={{ fontFamily: 'monospace', gap: 1, minWidth: 96 }}
          >
            <CheckIcon fontSize="small" sx={{ visibility: r === rate ? 'visible' : 'hidden' }} />
            {r}×
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
