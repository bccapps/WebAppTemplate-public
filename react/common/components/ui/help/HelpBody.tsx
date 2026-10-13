/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Box } from '@mui/material';
import { i18n } from '../../../core/i18n/I18n';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { resolveHelp } from './helpText';
import type { Help } from './helpText';

/** Explanation shown in a tooltip: short title, body, optional advice line. */
export function HelpBody(help: Help) {
  useI18nVersion();
  const { title, body, tip } = resolveHelp(help, i18n.get);
  return (
    <Box sx={{ display: 'grid', gap: 0.75 }}>
      {title && <Box sx={{ fontWeight: 600, fontSize: 12.5 }}>{title}</Box>}
      {body && <Box sx={{ whiteSpace: 'pre-line', color: 'text.secondary' }}>{body}</Box>}
      {tip && (
        <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 0.75, color: 'text.secondary' }}>
          <Box component="b" sx={{ fontWeight: 600, color: 'primary.main' }}>
            {i18n.get('common.ui.help.tip')}
          </Box>{' '}
          {tip}
        </Box>
      )}
    </Box>
  );
}
