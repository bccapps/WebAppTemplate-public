/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Labels of one language: key -> text. */
export type LocaleLabels = Record<string, string>;

/** A module of `import.meta.glob(..., { eager: true })`: the JSON content is its default export (or the module itself). */
type LocaleFileModule = { default?: LocaleLabels } | LocaleLabels;

/**
 * Merges the `locales/locales.<lang>.json` files bundled with the linked modules (`react/<module>/locales`, reached through
 * `src/modules_shared/<module>/locales`) into one dictionary per language. Files are merged in path order, a later module
 * overriding an earlier one on the same key.
 *
 * These labels ship in the front bundle: they do NOT depend on the locales mode (`localesLocation` `remote` or `local`) nor on
 * the back, whose `/locales` route only serves `common.<lang>.json`, `custom.<lang>.json` and the `locales/` of the linked
 * Nest modules. A module therefore never needs its keys added to the shared `common.*.json`.
 *
 * @param files result of the eager glob, keyed by file path
 */
export function mergeModuleLocales(files: Record<string, unknown>): Record<string, LocaleLabels> {
  const merged: Record<string, LocaleLabels> = {};
  for (const [filePath, file] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const lang = filePath.match(/locales\.([^./]+)\.json$/)?.[1];
    if (!lang) continue;
    const payload = file as LocaleFileModule;
    const labels = ('default' in payload && payload.default ? payload.default : payload) as LocaleLabels;
    merged[lang] = { ...merged[lang], ...labels };
  }
  return merged;
}
