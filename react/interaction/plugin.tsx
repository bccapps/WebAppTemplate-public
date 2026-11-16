/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { configurationService } from '../common/services/ConfigurationService';
import { sessionAuth } from '../common/auth/sessionAuth';
import { useSessionKeys } from '../common/hooks/useSessionKeys';
import Unauthorized from '../common/components/ui/unauthorized/Unauthorized';
import type { AppPlugin, AppPluginFactory, HeaderActionsProps } from '../common/plugins/AppPlugin';
import { RequireAdmin } from '../common/plugins/guards';
import { InteractionInboxBadge } from './components/InteractionInbox';
import { INTERACTION_ALLOW_USERS_KEY, canUseInteraction } from './pure/interactionAccess';
import { InteractionHostProvider } from './components/InteractionPluginParts';

export interface InteractionPluginOptions {
  /** Mounts `<InteractionHost />` (toasts / native notifications / question modal); default `true`. */
  host?: boolean;
  /** Inbox badge in the header (for the users `interaction_allowUsers` lets through); default `true`. */
  headerBadge?: boolean;
  /** The user's page (inbox, channels, preferences) and the admin page; default `true`. */
  routes?: boolean;
  /** Path of the user's page; default `/interaction`. */
  path?: string;
  /** Path of the admin page; default `/admin/interaction`. */
  adminPath?: string;
}

/** Admins always; other signed-in users when the admin switch « Allow interactions for users » is on (reactive: config + session). */
function useInteractionAllowed({ isAuth, isAdmin }: HeaderActionsProps): boolean {
  useSessionKeys(['config', 'user']);
  return canUseInteraction({ isAuth, isAdmin, allowUsers: configurationService.get(INTERACTION_ALLOW_USERS_KEY) });
}

/** Header action of the plugin: the badge, leading to the module's page. */
function headerBadge(path: string) {
  return function InteractionHeaderBadge(props: HeaderActionsProps) {
    const navigate = useNavigate();
    return useInteractionAllowed(props) ? <InteractionInboxBadge onOpen={() => navigate(path)} /> : null;
  };
}

/** Route guard of the user's page: signed in, and allowed by the admin switch (admins always). */
function RequireInteractionAccess({ children }: { children: ReactNode }) {
  const allowed = useInteractionAllowed({ isAuth: sessionAuth.isAuth(), isAdmin: sessionAuth.isAdmin() });
  return allowed ? <>{children}</> : <Unauthorized />;
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
          routes: [{ path, lazy: () => import('./components/InteractionPages'), guard: RequireInteractionAccess }],
          adminRoutes: [{ path: adminPath, lazy: () => import('./components/InteractionAdminPage'), guard: RequireAdmin }],
        }
      : {}),
  } satisfies AppPlugin;
};
createInteractionPlugin.pluginId = 'interaction';

export const plugin = createInteractionPlugin;
