/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


/**
 * Merge helper for back/jest.config.js: deep-merges the `jest` object of an app's
 * package.local.json over the shared jest configuration.
 * Plain objects are merged key by key (so `moduleNameMapper` and `transform` entries of the
 * app add to / replace the shared entry with the same key); arrays and scalars are replaced.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function mergeJestConfig(shared, local) {
  if (!isPlainObject(local)) return shared;
  const out = { ...shared };
  for (const [key, value] of Object.entries(local)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeJestConfig(out[key], value) : value;
  }
  return out;
}

export function readLocalJest(stackDir) {
  const file = path.join(stackDir, 'package.local.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')).jest;
}
