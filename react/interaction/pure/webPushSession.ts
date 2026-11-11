/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// The Web Push subscription of this browser follows the signed-in user (second review, finding 4): once the user who
// subscribed it leaves (logout, session end, another account), it is dropped, so a shared device never keeps showing
// the previous user's notices. Pure: no browser API, no React.

/** The id of the signed-in user (`sessionAuth.get()?.id`), `null` when nobody is signed in. */
export type SessionUserId = number | string | null;

/** `unsubscribe` when the user changes away from a known one (to nobody or to someone else); `keep` otherwise. */
export function webPushActionOnSessionChange(previous: SessionUserId, current: SessionUserId): 'keep' | 'unsubscribe' {
  return previous !== null && String(previous) !== String(current ?? '') ? 'unsubscribe' : 'keep';
}

/**
 * Remembers the signed-in user and calls `unsubscribe` (never awaited, never throwing) each time it changes away from a
 * known one. `initial`: the user signed in when the tracker starts (a reload keeps the subscription).
 */
export function createWebPushSessionTracker(unsubscribe: () => Promise<void>, initial: SessionUserId = null): { observe(current: SessionUserId): 'keep' | 'unsubscribe' } {
  let previous = initial;
  return {
    observe(current) {
      const action = webPushActionOnSessionChange(previous, current);
      previous = current;
      if (action === 'unsubscribe') void unsubscribe().catch(() => undefined);
      return action;
    },
  };
}
