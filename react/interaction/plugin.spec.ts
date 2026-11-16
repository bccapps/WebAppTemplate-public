/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('./components/InteractionPluginParts', () => ({ InteractionHostProvider: () => null }));
vi.mock('react-router-dom', () => ({ useNavigate: () => () => undefined }));
vi.mock('./components/InteractionInbox', () => ({ InteractionInboxBadge: () => 'badge' }));
vi.mock('../common/plugins/guards', () => ({ RequireAdmin: () => null }));
const { allowUsers, session } = vi.hoisted(() => ({ allowUsers: { value: false as unknown }, session: { isAuth: true, isAdmin: false } }));
vi.mock('../common/services/ConfigurationService', () => ({ configurationService: { get: () => allowUsers.value } }));
vi.mock('../common/auth/sessionAuth', () => ({ sessionAuth: { isAuth: () => session.isAuth, isAdmin: () => session.isAdmin } }));
vi.mock('../common/hooks/useSessionKeys', () => ({ useSessionKeys: () => undefined }));
vi.mock('../common/components/ui/unauthorized/Unauthorized', () => ({ default: () => null }));

import { collectPlugins } from '../common/plugins/AppPlugin';
import { createInteractionPlugin, plugin } from './plugin';

describe('interaction plugin', () => {
  it('mounts the host, the header badge and the two pages by default', () => {
    const built = createInteractionPlugin(undefined);
    expect(built.id).toBe('interaction');
    expect(built.Provider).toBeDefined();
    expect(built.providerPlacement).toBe('inner');
    expect(built.HeaderActions).toBeDefined();
    expect(built.routes?.map((route) => route.path)).toEqual(['/interaction']);
    expect(built.adminRoutes?.map((route) => route.path)).toEqual(['/admin/interaction']);
  });

  it('turns each part off and moves the pages', () => {
    const built = createInteractionPlugin({ host: false, headerBadge: false, routes: false });
    expect([built.Provider, built.HeaderActions, built.routes, built.adminRoutes]).toEqual([undefined, undefined, undefined, undefined]);
    expect(createInteractionPlugin({ path: '/me/alerts' }).routes?.[0].path).toBe('/me/alerts');
  });

  it('shows the header badge to admins, and to other users only when interaction_allowUsers is on', () => {
    const render = (isAuth: boolean, isAdmin: boolean) =>
      (createInteractionPlugin(undefined).HeaderActions as unknown as (props: { isAuth: boolean; isAdmin: boolean }) => unknown)({ isAuth, isAdmin });
    allowUsers.value = false;
    expect(render(true, true)).not.toBeNull();
    expect(render(true, false)).toBeNull();
    expect(render(false, false)).toBeNull();
    allowUsers.value = true;
    expect(render(true, false)).not.toBeNull();
    expect(render(false, false)).toBeNull();
  });

  it('guards the user page with the same rule', () => {
    const Guard = createInteractionPlugin(undefined).routes![0].guard as unknown as (props: { children: string }) => { props: { children: string } };
    const shown = () => Guard({ children: 'page' }).props.children === 'page';
    session.isAuth = true;
    session.isAdmin = false;
    allowUsers.value = false;
    expect(shown()).toBe(false);
    allowUsers.value = true;
    expect(shown()).toBe(true);
    allowUsers.value = false;
    session.isAdmin = true;
    expect(shown()).toBe(true);
  });

  it('refuses invalid options', () => {
    expect(() => createInteractionPlugin({ host: 'yes' as unknown as boolean })).toThrow(/host must be a boolean/);
    expect(() => createInteractionPlugin({ path: 'https://evil.test' })).toThrow(/path must be an app path/);
  });

  it('is collected under its id with the app options', () => {
    const [collected] = collectPlugins({ './modules_shared/interaction/plugin.tsx': { plugin } }, { interaction: { headerBadge: false } });
    expect(collected.id).toBe('interaction');
    expect(collected.HeaderActions).toBeUndefined();
  });
});
