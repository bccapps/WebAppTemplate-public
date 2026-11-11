/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Pure rules of the in-app display (04 §10.4, extracted from AgentHub `notifications/notificationChannel.ts`): which
// surface shows a notice while the app is open, the stable tag that makes a repeat replace the previous one, and when
// the page offers to ask the browser permission. Nothing here touches `window`.

import type { InappDisplay } from '../types/interactionTypes';

/** `Notification.permission`, or `unsupported` when the browser has no Notification API. */
export type BrowserPermission = NotificationPermission | 'unsupported';

/**
 * `native` only when the wanted display is `browser`, the API exists and the permission is `granted`; otherwise the
 * toast (`default`, `denied`, `unsupported`: a silent fallback, invariant 1 — nothing is lost while the permission is
 * pending).
 */
export function decideInappDisplay(wanted: InappDisplay | null | undefined, permission: BrowserPermission): 'native' | 'toast' {
  return wanted === 'browser' && permission === 'granted' ? 'native' : 'toast';
}

/** Stable per target: a repeat replaces the previous notification instead of stacking. */
export function notificationTag(notice: { id: string; url?: string | null }): string {
  return notice.url ? `vx-interaction:${notice.url}` : `vx-interaction:${notice.id}`;
}

/** Whether to show « Enable browser notifications »: only for the `browser` display, while the browser can still ask. */
export function shouldPromptForPermission(wanted: InappDisplay | null | undefined, permission: BrowserPermission, dismissed: boolean): boolean {
  return wanted === 'browser' && permission === 'default' && !dismissed;
}

/** What the host needs from the browser to show a notice; injected so the rule is testable without a DOM. */
export interface NoticeSurface {
  permission(): BrowserPermission;
  /** Shows a native notification; resolves false when it could not (no service worker, blocked, thrown). */
  showNative(input: { title: string; body: string; tag: string; url: string | null }): Promise<boolean>;
  showToast(): void;
}

/**
 * Shows one notice: native when `decideInappDisplay` says so AND the browser really shows it, the toast otherwise.
 * Never throws (a failing native display falls back to the toast: no visible error).
 */
export async function displayNotice(
  wanted: InappDisplay | null | undefined,
  input: { title: string; body: string; tag: string; url: string | null },
  surface: NoticeSurface,
): Promise<'native' | 'toast'> {
  let permission: BrowserPermission;
  try {
    permission = surface.permission();
  } catch {
    permission = 'unsupported';
  }
  if (decideInappDisplay(wanted, permission) === 'native') {
    const shown = await surface.showNative(input).catch(() => false);
    if (shown) return 'native';
  }
  surface.showToast();
  return 'toast';
}
