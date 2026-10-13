/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { MenuSection } from '@/modules_shared/common/plugins/AppPlugin';

/**
 * Sidebar entries of the app, shown before those of the plugins (sections sharing an id are merged).
 * `appNavMenu`: every page layout. `appAdminMenu`: `admin` layout pages, admins only.
 * An item is `{ id, labelId (i18n key), to, icon, visible?(ctx) }` with `ctx = { isAdmin, isAuth, hasFeature(id) }`.
 * Both lists are empty by default; with no visible entry the sidebar is not rendered.
 */
export const appNavMenu: MenuSection[] = [];
export const appAdminMenu: MenuSection[] = [];
