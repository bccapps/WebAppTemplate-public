/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from 'vitest';
import type { MenuContext, MenuSection } from './AppPlugin';
import { mergeMenuSections, resolveMenu } from './menus';

const icon = () => null;
const ctx = (over: Partial<MenuContext> = {}): MenuContext => ({ isAdmin: false, isAuth: false, hasFeature: () => true, ...over });
const item = (id: string, visible?: (c: MenuContext) => boolean) => ({ id, labelId: `l.${id}`, to: `/${id}`, icon, visible });
const section = (id: string, ...items: ReturnType<typeof item>[]): MenuSection => ({ id, labelId: `s.${id}`, items });

describe('resolveMenu', () => {
  const sections = [
    section('main', item('home'), item('admin', (c) => c.isAdmin), item('pro', (c) => c.hasFeature('pro'))),
    section('private', item('me', (c) => c.isAuth)),
  ];

  it('keeps items without predicate and drops empty sections', () => {
    const result = resolveMenu(sections, ctx());
    expect(result.map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([['main', ['home', 'pro']]]);
  });

  it('evaluates isAdmin, isAuth and hasFeature', () => {
    const result = resolveMenu(sections, ctx({ isAdmin: true, isAuth: true, hasFeature: (id) => id !== 'pro' }));
    expect(result.map((s) => s.items.map((i) => i.id))).toEqual([['home', 'admin'], ['me']]);
  });

  it('adminOnly hides everything from non-admins and does not mutate the input', () => {
    expect(resolveMenu(sections, ctx(), { adminOnly: true })).toEqual([]);
    expect(resolveMenu(sections, ctx({ isAdmin: true }), { adminOnly: true })).toHaveLength(1);
    expect(sections[0].items).toHaveLength(3);
  });
});

describe('mergeMenuSections', () => {
  it('merges sections with the same id, app first, first item id wins', () => {
    const merged = mergeMenuSections([section('s', item('a'), item('b'))], undefined, [section('s', item('b'), item('c')), section('t', item('d'))]);
    expect(merged.map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([['s', ['a', 'b', 'c']], ['t', ['d']]]);
  });
});
