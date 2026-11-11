/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useNavigate } from 'react-router-dom';
import type { AppPlugin, AppPluginFactory, HeaderActionsProps } from '../common/plugins/AppPlugin';
import { RequireAdmin, RequireAuth } from '../common/plugins/guards';
import { InteractionInboxBadge } from './components/InteractionInbox';
import { InteractionHostProvider } from './components/InteractionPluginParts';

export interface InteractionPluginOptions {
  /** Mounts `<InteractionHost />` (toasts / native notifications / question modal); default `true`. */
  host?: boolean;
  /** Inbox badge in the header; default `true`. */
  headerBadge?: boolean;
  /** The user's page (inbox, channels, preferences) and the admin page; default `true`. */
  routes?: boolean;
  /** Path of the user's page; default `/interaction`. */
  path?: string;
  /** Path of the admin page; default `/admin/interaction`. */
  adminPath?: string;
}

/** Header action of the plugin: the badge, leading to the module's page. */
function headerBadge(path: string) {
  return function InteractionHeaderBadge({ isAuth }: HeaderActionsProps) {
    const navigate = useNavigate();
    return isAuth ? <InteractionInboxBadge onOpen={() => navigate(path)} /> : null;
  };
}

function booleanOption(name: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new Error(`Plugin "interaction": ${name} must be a boolean (got "${String(value)}")`);
  return value;
}

function pathOption(name: string, value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9/_-]*$/.test(value)) throw new Error(`Plugin "interaction": ${name} must be an app path (got "${String(value)}")`);
  return value;
}

export const createInteractionPlugin: AppPluginFactory<InteractionPluginOptions> = (options) => {
  const host = booleanOption('host', options?.host);
  const badge = booleanOption('headerBadge', options?.headerBadge);
  const routes = booleanOption('routes', options?.routes);
  const path = pathOption('path', options?.path, '/interaction');
  const adminPath = pathOption('adminPath', options?.adminPath, '/admin/interaction');
  return {
    id: 'interaction',
    ...(host ? { Provider: InteractionHostProvider, providerPlacement: 'inner' as const } : {}),
    ...(badge ? { HeaderActions: headerBadge(path) } : {}),
    ...(routes
      ? {
          routes: [{ path, lazy: () => import('./components/InteractionPages'), guard: RequireAuth }],
          adminRoutes: [{ path: adminPath, lazy: () => import('./components/InteractionAdminPage'), guard: RequireAdmin }],
        }
      : {}),
  } satisfies AppPlugin;
};
createInteractionPlugin.pluginId = 'interaction';

export const plugin = createInteractionPlugin;
