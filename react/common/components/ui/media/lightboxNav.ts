/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export type LightboxKeyAction = 'previous' | 'next' | null;

/** Action of a key press in the viewer: ←/→ navigate (Escape is handled by the dialog). */
export function lightboxKeyAction(key: string): LightboxKeyAction {
  if (key === 'ArrowLeft') return 'previous';
  if (key === 'ArrowRight') return 'next';
  return null;
}

/** Index to show after `action`, or null when already at the edge (no wrap-around). */
export function stepIndex(index: number, count: number, action: Exclude<LightboxKeyAction, null>): number | null {
  const target = action === 'next' ? index + 1 : index - 1;
  return target >= 0 && target < count ? target : null;
}

/** Keeps an index inside 0..count-1 (0 when the list is empty); use after the list changed. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor(index)));
}

/** "3 / 12" counter text (1-based position). */
export function counterText(index: number, count: number): string {
  return `${clampIndex(index, count) + 1} / ${count}`;
}
