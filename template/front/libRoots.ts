/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Existing shared-library roots of a front/ stack, in resolution order
 * (vx-public, vx-private, legacy .libs/reactcommon).
 * Keep in sync with libRoots() in scripts/lib-roots.mjs (not imported here: the
 * vite config is type-checked and the .mjs script has no typings).
 */
import { statSync } from 'fs'
import path from 'path'

const isDir = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export function libRoots(stackDir: string): string[] {
  const libs = path.join(stackDir, '.libs')
  return [
    path.join(libs, 'vx-public', 'react'),
    path.join(libs, 'vx-private', 'react'),
    path.join(libs, 'reactcommon'),
  ].filter(isDir)
}
