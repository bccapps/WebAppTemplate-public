/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { createElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import type { AppPlugin, PluginRoute } from './AppPlugin';
import { resolveRoutes, RouteConfigError } from './resolveRoutes';
import { layoutForPath } from './routeLayout';

const el = (name: string) => createElement('div', { 'data-name': name });
const route = (path: string, name = path): PluginRoute => ({ path, element: el(name) });

describe('resolveRoutes', () => {
  it('lists app routes, then plugin routes and adminRoutes in plugin order, with default layouts', () => {
    const plugins: AppPlugin[] = [
      { id: 'p1', routes: [route('/p1')], adminRoutes: [route('/admin/p1')] },
      { id: 'p2', routes: [{ ...route('/full'), layout: 'fullscreen' }] },
    ];
    const result = resolveRoutes({ appRoutes: [route('/app')], plugins });
    expect(result.map((r) => [r.path, r.layout, r.source])).toEqual([
      ['/app', 'page', 'app'],
      ['/p1', 'page', 'p1'],
      ['/admin/p1', 'admin', 'p1'],
      ['/full', 'fullscreen', 'p2'],
    ]);
  });

  it('throws on a duplicated path in strict mode, logs and keeps the first otherwise', () => {
    const plugins: AppPlugin[] = [{ id: 'p1', routes: [route('/x', 'plugin')] }];
    expect(() => resolveRoutes({ appRoutes: [route('/x')], plugins, strict: true })).toThrow(RouteConfigError);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = resolveRoutes({ appRoutes: [route('/x', 'app')], plugins });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('app');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Duplicate route "/x"'));
    error.mockRestore();
  });

  it('lets the app disable or replace a plugin route by path, and solves the duplicate that way', () => {
    const plugins: AppPlugin[] = [{ id: 'roadmap', routes: [route('/roadmap'), route('/other')] }];
    const replaced = resolveRoutes({
      appRoutes: [route('/roadmap', 'mine')],
      plugins,
      overrides: { '/roadmap': false, '/other': { element: el('custom'), layout: 'fullscreen' } },
      strict: true,
    });
    expect(replaced.map((r) => r.path)).toEqual(['/roadmap', '/other']);
    expect(replaced[0].source).toBe('app');
    expect(replaced[1].layout).toBe('fullscreen');
    expect((replaced[1].element.props as Record<string, string>)['data-name']).toBe('custom');
  });

  it('does not apply overrides to the routes of the app', () => {
    const result = resolveRoutes({ appRoutes: [route('/app')], plugins: [], overrides: { '/app': false } });
    expect(result).toHaveLength(1);
  });

  it('wraps the element in the guard and builds lazy elements', () => {
    const Guard = ({ children }: { children?: unknown }) => createElement('section', null, children as never);
    const lazyRoute: PluginRoute = { path: '/lazy', lazy: () => Promise.resolve({ default: () => el('l') }), guard: Guard };
    const [guarded, lazy] = resolveRoutes({ plugins: [{ id: 'p', routes: [{ ...route('/g'), guard: Guard }, lazyRoute] }] });
    expect(guarded.element.type).toBe(Guard);
    expect(lazy.element.type).toBe(Guard);
    expect((lazy.element.props as { children: { type: unknown } }).children.type).not.toBe(Guard);
  });

  it('rejects a route with both or neither of element and lazy', () => {
    const none = { path: '/none' } as unknown as PluginRoute;
    const both = { path: '/both', element: el('x'), lazy: () => Promise.resolve({ default: () => null }) } as unknown as PluginRoute;
    expect(() => resolveRoutes({ plugins: [{ id: 'p', routes: [none] }] })).toThrow(/exactly one/);
    expect(() => resolveRoutes({ plugins: [{ id: 'p', routes: [both] }] })).toThrow(/exactly one/);
  });

  it('an override with lazy drops the original element', () => {
    const [r] = resolveRoutes({
      plugins: [{ id: 'p', routes: [route('/x')] }],
      overrides: { '/x': { lazy: () => Promise.resolve({ default: () => null }) } },
    });
    expect(r.element.type).not.toBe('div');
  });
});

describe('layoutForPath', () => {
  const routes = [{ path: '/admin/:tab', layout: 'admin' as const }, { path: '/login', layout: 'fullscreen' as const }];
  it('matches patterns and defaults to page', () => {
    expect(layoutForPath(routes, '/admin/user')).toBe('admin');
    expect(layoutForPath(routes, '/login')).toBe('fullscreen');
    expect(layoutForPath(routes, '/nowhere')).toBe('page');
  });
});
