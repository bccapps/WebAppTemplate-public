/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { matchPath } from 'react-router-dom';
import type { RouteLayout } from './AppPlugin';
import type { ResolvedRoute } from './resolveRoutes';

/** Layout of the route matching `pathname` (`page` when none matches, e.g. the 404). */
export function layoutForPath(routes: ReadonlyArray<Pick<ResolvedRoute, 'path' | 'layout'>>, pathname: string): RouteLayout {
  return routes.find((route) => matchPath({ path: route.path, end: true }, pathname))?.layout ?? 'page';
}
