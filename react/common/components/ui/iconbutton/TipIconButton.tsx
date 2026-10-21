/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import type { IconButtonProps } from '@mui/material';
import { i18n } from '../../../core/i18n/I18n';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { HelpBody } from '../help/HelpBody';
import { helpTooltipSlotProps } from '../help/helpTooltip';
import type { TipSide } from '../help/InfoTip';
import { Kbd } from '../kbd/Kbd';
import { tipIconButtonSx } from './tipIconButtonStyle';
import type { TipIconButtonTone } from './tipIconButtonStyle';

export interface TipIconButtonProps extends Omit<IconButtonProps, 'color' | 'title'> {
  /** i18n key of the accessible name; it is also the tooltip text. */
  labelId: string;
  /** Keyboard shortcut shown in the tooltip. */
  kbd?: string;
  /** i18n key of a longer explanation: the tooltip then wraps and shows it under the label. */
  hintId?: string;
  tone?: TipIconButtonTone;
  /** Toggled/selected look; `aria-pressed` is set too. */
  active?: boolean;
  tipSide?: TipSide;
  children: ReactNode;
}

/** Icon button with an accessible name and a tooltip (label, optional shortcut, optional hint). */
export const TipIconButton = forwardRef<HTMLButtonElement, TipIconButtonProps>(function TipIconButton(
  { labelId, kbd, hintId, tone = 'ghost', active = false, tipSide = 'top', sx, children, ...rest },
  ref,
) {
  useI18nVersion();
  const label = i18n.get(labelId);
  const title = hintId ? (
    <HelpBody title={label} bodyId={hintId} />
  ) : (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      {label}
      {kbd && <Kbd>{kbd}</Kbd>}
    </Box>
  );
  return (
    <Tooltip title={title} placement={tipSide} enterDelay={350} slotProps={helpTooltipSlotProps}>
      {/* The span keeps the tooltip working on a disabled button. */}
      <span style={{ display: 'inline-flex' }}>
        <IconButton
          ref={ref}
          aria-label={label}
          aria-pressed={rest['aria-pressed'] ?? (active ? true : undefined)}
          sx={[tipIconButtonSx(tone, active), ...(Array.isArray(sx) ? sx : [sx])]}
          {...rest}
        >
          {children}
        </IconButton>
      </span>
    </Tooltip>
  );
});
