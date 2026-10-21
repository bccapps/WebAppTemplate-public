/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Props of the tooltip surface shared by the help components (readable, wraps long explanations). */
export const helpTooltipSlotProps = {
  tooltip: {
    sx: {
      bgcolor: 'background.paper',
      color: 'text.primary',
      border: 1,
      borderColor: 'divider',
      boxShadow: 6,
      fontSize: 12,
      lineHeight: 1.5,
      maxWidth: 'min(19rem, calc(100vw - 24px))',
      px: 1.5,
      py: 1.25,
    },
  },
} as const;
