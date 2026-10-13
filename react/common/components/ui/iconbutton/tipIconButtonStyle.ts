/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export type TipIconButtonTone = 'ghost' | 'default' | 'danger';

/** `sx` of a `TipIconButton` for a tone and an active (toggled) state. */
export function tipIconButtonSx(tone: TipIconButtonTone, active: boolean): Record<string, unknown> {
  const base = { borderRadius: 2, '&.Mui-disabled': { opacity: 0.4 } };
  const tones: Record<TipIconButtonTone, Record<string, unknown>> = {
    ghost: { color: 'text.secondary', '&:hover': { bgcolor: 'action.hover', color: 'text.primary' } },
    default: {
      color: 'text.primary',
      border: 1,
      borderColor: 'divider',
      '&:hover': { borderColor: 'text.secondary' },
    },
    danger: { color: 'text.secondary', '&:hover': { bgcolor: 'action.hover', color: 'error.main' } },
  };
  return { ...base, ...tones[tone], ...(active ? { bgcolor: 'action.selected', color: 'text.primary' } : {}) };
}
