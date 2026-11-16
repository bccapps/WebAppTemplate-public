/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Public configuration key of the admin switch « Allow interactions for users ». */
export const INTERACTION_ALLOW_USERS_KEY = 'interaction_allowUsers';

/** Whether the header bell and the user page are offered: admins always, other signed-in users only when the switch is on. */
export function canUseInteraction(input: { isAuth: boolean; isAdmin: boolean; allowUsers: unknown }): boolean {
  if (!input.isAuth) return false;
  return input.isAdmin || input.allowUsers === true;
}
