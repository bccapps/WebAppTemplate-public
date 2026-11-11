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
vi.mock('./components/InteractionInbox', () => ({ InteractionInboxBadge: () => null }));
vi.mock('../common/plugins/guards', () => ({ RequireAdmin: () => null, RequireAuth: () => null }));

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
