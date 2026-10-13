/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { PluginRouteOverrides } from '@/modules_shared/common/plugins/resolveRoutes';

/**
 * Overrides of the routes declared by plugins, by path: `false` removes the route, an object replaces its fields
 * (`lazy` or `element`, `guard`, `layout`). Empty by default. This file is plain TypeScript: give a replacement page as
 * `lazy: () => import('@/components/pages/MyRoadmap')` (default export) rather than JSX. Example:
 * `{ '/roadmap': false, '/commerce/checkout': { lazy: () => import('@/components/pages/Checkout'), layout: 'fullscreen' } }`.
 * The routes of the app itself live in `components/Router.tsx` (a path declared by both is an error in dev: disable the
 * plugin one here).
 */
export const pluginRouteOverrides: PluginRouteOverrides = {};
