/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Reader of the single registry of secret formats, `nest/common/validation/secret-formats.json` of vx-public, for the
// template scripts (gitleaks rules, leak scan of the logs). The runtime reads the same file through
// `nest/common/validation/secretFormats.ts`.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(realpathSync(fileURLToPath(import.meta.url)));

/**
 * Where the registry is: next to this script in the vx-public checkout (`template/scripts/lib` → `nest/common/...`), or,
 * in a dereferenced copy of `<stack>/.libs/apptemplate` (deploy staging), through the sibling `.libs/vx-public` mount.
 */
export const SECRET_FORMATS_CANDIDATES = [
  path.resolve(LIB_DIR, '../../../nest/common/validation/secret-formats.json'),
  path.resolve(LIB_DIR, '../../../vx-public/nest/common/validation/secret-formats.json'),
];

export function secretFormatsPath(candidates = SECRET_FORMATS_CANDIDATES) {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`secret-formats.json not found (looked in: ${candidates.join(', ')}): is the vx-public mount initialised?`);
  return found;
}

let cached = null;

/** The parsed registry (`formats`, `oauth`, `charsets`, `fakeMarkers`, `identifiers`). */
export function loadSecretFormats(file = secretFormatsPath()) {
  if (cached?.file === file) return cached.registry;
  const registry = JSON.parse(readFileSync(file, 'utf8'));
  for (const format of registry.formats) {
    if (!/^[a-z][a-z0-9_]{1,10}_$/.test(format.prefix)) throw new Error(`secret-formats.json: ${format.id}: bad prefix`);
    if (!registry.charsets[format.charset]) throw new Error(`secret-formats.json: ${format.id}: unknown charset ${format.charset}`);
  }
  cached = { file, registry };
  return registry;
}

/** Every distinct prefix of the registry, in registry order. */
export function secretPrefixes(registry = loadSecretFormats()) {
  return [...new Set(registry.formats.map((format) => format.prefix))];
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
