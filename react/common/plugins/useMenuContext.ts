/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { sessionAuth } from '../auth/sessionAuth';
import { useSessionKeys } from '../hooks/useSessionKeys';
import type { MenuContext } from './AppPlugin';
import { hasFeature } from './featureAccess';

/** Current visitor, re-evaluated when the session changes. */
export function useMenuContext(): MenuContext {
  useSessionKeys(['user']);
  return { isAdmin: sessionAuth.isAdmin(), isAuth: sessionAuth.isAuth(), hasFeature };
}
