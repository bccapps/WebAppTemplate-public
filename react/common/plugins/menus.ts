/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { MenuContext, MenuItem, MenuSection } from './AppPlugin';

/** Merge sections sharing an id (app entries first, then plugins), keeping the first item of a duplicated item id. */
export function mergeMenuSections(...lists: ReadonlyArray<ReadonlyArray<MenuSection> | undefined>): MenuSection[] {
  const byId = new Map<string, MenuSection>();
  for (const section of lists.flatMap((list) => list ?? [])) {
    const existing = byId.get(section.id);
    if (!existing) {
      byId.set(section.id, { ...section, items: [...section.items] });
      continue;
    }
    const known = new Set(existing.items.map((item) => item.id));
    existing.items.push(...section.items.filter((item) => !known.has(item.id)));
  }
  return [...byId.values()];
}

const isVisible = (item: MenuItem, ctx: MenuContext): boolean => item.visible?.(ctx) ?? true;

/** Keep the visible items; sections left empty disappear. `adminOnly` hides everything from non-admins. */
export function resolveMenu(
  sections: ReadonlyArray<MenuSection>,
  ctx: MenuContext,
  options: { adminOnly?: boolean } = {},
): MenuSection[] {
  if (options.adminOnly && !ctx.isAdmin) return [];
  return sections
    .map((section) => ({ ...section, items: section.items.filter((item) => isVisible(item, ctx)) }))
    .filter((section) => section.items.length > 0);
}
