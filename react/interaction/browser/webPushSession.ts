/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useRef } from 'react';
import { createWebPushSessionTracker, type SessionUserId } from '../pure/webPushSession';
import { disableWebPush } from './browserNotifications';

/**
 * Drops this browser's Web Push subscription when the signed-in user changes away from the one it started with
 * (second review, finding 4): `disableWebPush()` (the browser's subscription is cancelled at its push service, so the
 * back's next send gets `410` and deletes the row even when the `remove` call is refused after a logout). Called by
 * `<InteractionHost />` with the session user (`useSessionKeys(['user'])` re-renders it on login / logout).
 */
export function useWebPushSessionGuard(userId: SessionUserId, unsubscribe: () => Promise<void> = disableWebPush): void {
  const tracker = useRef<ReturnType<typeof createWebPushSessionTracker> | null>(null);
  tracker.current ??= createWebPushSessionTracker(unsubscribe, userId);
  useEffect(() => {
    tracker.current?.observe(userId);
  }, [userId]);
}
