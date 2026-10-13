/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Box, LinearProgress, Typography } from '@mui/material';
import { i18n } from '../../../core/i18n/I18n';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { computePercent, estimateRemaining, formatBytes, formatDuration, formatRate } from './progressFormat';

export interface ProgressBarProps {
  /** Bytes done so far. */
  done: number;
  /** Total bytes; 0 or less shows the "preparing" state. */
  total: number;
  /** Bytes per second. */
  rate?: number;
  /** Remaining seconds; estimated from `rate` when omitted. */
  etaSeconds?: number | null;
}

/** Determinate progress in bytes: "12 Mo / 340 Mo · 4 %", rate and remaining time (localized). */
export function ProgressBar({ done, total, rate, etaSeconds }: ProgressBarProps) {
  useI18nVersion();
  const locale = i18n.getLang();
  const percent = computePercent(done, total);
  const remaining = estimateRemaining(done, total, rate, etaSeconds);
  const counts =
    percent === null
      ? i18n.get('common.ui.progress.preparing')
      : `${formatBytes(done, locale)} / ${formatBytes(total, locale)} · ${new Intl.NumberFormat(locale, { style: 'percent' }).format(percent / 100)}`;
  const speed = [
    rate && rate > 0 ? formatRate(rate, locale) : '',
    remaining != null ? i18n.get('common.ui.progress.remaining', [formatDuration(remaining, locale)]) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Box sx={{ mt: 1.5 }}>
      <LinearProgress
        variant={percent === null ? 'indeterminate' : 'determinate'}
        value={percent ?? undefined}
        aria-label={i18n.get('common.ui.progress.label')}
        sx={{ height: 6, borderRadius: 3 }}
      />
      <Box sx={{ mt: 0.75, display: 'flex', justifyContent: 'space-between', gap: 2 }}>
        <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
          {counts}
        </Typography>
        <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
          {speed}
        </Typography>
      </Box>
    </Box>
  );
}
