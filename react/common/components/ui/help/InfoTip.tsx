/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useState } from 'react';
import { ButtonBase, Tooltip } from '@mui/material';
import HelpOutlinedIcon from '@mui/icons-material/HelpOutlined';
import { i18n } from '../../../core/i18n/I18n';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { HelpBody } from './HelpBody';
import { helpTooltipSlotProps } from './helpTooltip';
import { infoTipAriaLabel, resolveHelp } from './helpText';
import type { Help } from './helpText';

export type TipSide = 'top' | 'bottom' | 'left' | 'right';

/**
 * Discreet "?" button next to a label. The tooltip opens on hover, on keyboard focus and on tap/click, and closes on
 * Escape. It never takes space from the control it describes (fixed 16 px box).
 */
export function InfoTip({ side = 'top', className, ...help }: Help & { side?: TipSide; className?: string }) {
  useI18nVersion();
  const [open, setOpen] = useState(false);
  const ariaLabel = infoTipAriaLabel(resolveHelp(help, i18n.get), i18n.get);
  return (
    <Tooltip
      title={<HelpBody {...help} />}
      placement={side}
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      enterDelay={200}
      enterTouchDelay={0}
      leaveTouchDelay={5000}
      slotProps={helpTooltipSlotProps}
    >
      <ButtonBase
        className={className}
        aria-label={ariaLabel}
        onClick={(event) => {
          // Touch devices never fire hover: a tap opens it explicitly, without activating a parent label/row.
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        sx={{
          width: 16,
          height: 16,
          flexShrink: 0,
          borderRadius: '50%',
          color: 'text.disabled',
          '&:hover, &:focus-visible': { color: 'text.primary' },
          '&.Mui-focusVisible': { outline: 2, outlineStyle: 'solid', outlineColor: 'primary.main' },
        }}
      >
        <HelpOutlinedIcon sx={{ fontSize: 14 }} aria-hidden />
      </ButtonBase>
    </Tooltip>
  );
}
