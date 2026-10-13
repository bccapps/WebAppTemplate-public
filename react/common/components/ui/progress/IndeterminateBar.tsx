/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useState } from 'react';
import { Box, LinearProgress, Typography } from '@mui/material';
import { i18n } from '../../../core/i18n/I18n';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { formatClock } from './progressFormat';

export interface IndeterminateBarProps {
  /** Status text from the running task (already translated); a localized "preparing" text when omitted. */
  message?: string;
  /** Secondary line (a file name, a log line...). */
  detail?: string;
  /** Start of the task, in epoch seconds: shows the elapsed time when set. */
  sinceEpochSeconds?: number;
}

/** Progress with no known percentage: message, detail and elapsed time (refreshed every second). */
export function IndeterminateBar({ message, detail, sinceEpochSeconds }: IndeterminateBarProps) {
  useI18nVersion();
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!sinceEpochSeconds) return undefined;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [sinceEpochSeconds]);
  return (
    <Box sx={{ mt: 1.5 }}>
      <LinearProgress aria-label={i18n.get('common.ui.progress.label')} sx={{ height: 6, borderRadius: 3 }} />
      <Box sx={{ mt: 0.75, display: 'flex', justifyContent: 'space-between', gap: 2 }}>
        <Typography variant="caption" noWrap sx={{ fontFamily: 'monospace', color: 'text.secondary', minWidth: 0 }}>
          {message || i18n.get('common.ui.progress.preparing')}
        </Typography>
        {sinceEpochSeconds ? (
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', flexShrink: 0 }}>
            {formatClock(now - sinceEpochSeconds)}
          </Typography>
        ) : null}
      </Box>
      {detail && (
        <Typography variant="caption" noWrap component="p" sx={{ fontFamily: 'monospace', color: 'text.disabled' }}>
          {detail}
        </Typography>
      )}
    </Box>
  );
}
