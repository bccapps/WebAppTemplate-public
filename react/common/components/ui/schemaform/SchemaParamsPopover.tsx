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
import { Badge, Popover } from '@mui/material';
import TuneIcon from '@mui/icons-material/Tune';
import { TipIconButton } from '../iconbutton/TipIconButton';
import { SchemaParamsForm } from './SchemaParamsForm';
import type { SchemaParamsFormProps } from './SchemaParamsForm';
import { isModified } from './schemaControls';

export interface SchemaParamsPopoverProps extends SchemaParamsFormProps {
  /** i18n key of the trigger button's name and tooltip. */
  triggerLabelId: string;
  /** Icon of the trigger button (default: sliders). */
  icon?: ReactNode;
  /** Popover width in px. Default 340. */
  width?: number;
}

/** Icon button that opens a `SchemaParamsForm` in a popover; a dot signals that a value differs from its default. */
export function SchemaParamsPopover({ triggerLabelId, icon, width = 340, ...form }: SchemaParamsPopoverProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <TipIconButton labelId={triggerLabelId} tone="default" active={anchor !== null} onClick={(event) => setAnchor(event.currentTarget)}>
        <Badge color="primary" variant="dot" invisible={!isModified(form.schema, form.values)}>
          {icon ?? <TuneIcon fontSize="small" />}
        </Badge>
      </TipIconButton>
      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width, maxWidth: 'calc(100vw - 24px)', p: 2 } } }}
      >
        <SchemaParamsForm {...form} />
      </Popover>
    </>
  );
}
