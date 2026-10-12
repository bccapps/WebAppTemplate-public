/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { collectPlugins, type AppPlugin } from '@/modules_shared/common/plugins/AppPlugin';

// Every linked shared module exposing a `plugin.tsx` is picked up here (via the modules_shared
// symlinks). Adding/removing a module in shared-modules.json needs no change in App/Router/Header.
const modules = import.meta.glob<{ plugin?: AppPlugin }>('./modules_shared/*/plugin.tsx', { eager: true });

export const appPlugins: AppPlugin[] = collectPlugins(modules);
export const userManagementEnabled = appPlugins.some((p) => p.id === 'user');
