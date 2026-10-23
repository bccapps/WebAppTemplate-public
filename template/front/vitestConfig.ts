/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Shared Vitest config factory for the front projects. Linked into each project as `front/vitestConfig.ts`
 * (see config-links.json) and consumed by the project's thin `vitest.config.ts`:
 *
 *   import { createVitestConfig } from './vitestConfig'
 *   export default createVitestConfig()
 *
 * Standalone on purpose: it does NOT extend `viteConfig.ts` (which pulls the full app graph). Scope: unit tests of
 * framework-agnostic logic (node environment by default, the `*.spec.ts` files under `src/`).
 *
 * `resolve.preserveSymlinks` is mandatory: the shared modules are symlinked into `src/modules_shared/`
 * (see scripts/link-shared.mjs). Without it Vite resolves a module to its real path (`.libs/vx-*` /react/<m>), where
 * a relative import of a sibling module (`../common/...`) points to nothing. `viteConfig.ts` sets it for the same reason.
 *
 * Project-relative paths use `process.cwd()` (the project's front/ dir), so the file is relocatable.
 */

import path from 'path'
import { defineConfig, type UserConfig } from 'vitest/config'

export interface VitestConfigOptions {
  /** Extra module aliases, merged over the built-in ones (`@` and `@jest/globals`). */
  alias?: Record<string, string>
  /** Test file globs (default: every `*.spec.ts` under `src/`). */
  include?: string[]
  /** Vitest environment (default `node`; use `jsdom` once the project installs it). */
  environment?: string
  /** Setup files run before each test file. */
  setupFiles?: string[]
}

export function createVitestConfig(opts: VitestConfigOptions = {}): UserConfig {
  const cwd = process.cwd()
  return defineConfig({
    resolve: {
      preserveSymlinks: true,
      alias: {
        // Specs shared verbatim with the back-end Jest harness import from '@jest/globals' (describe/expect/it only).
        '@jest/globals': 'vitest',
        // Mirrors the app alias of viteConfig.ts, so a pure-logic spec can import a modules_shared service.
        '@': path.resolve(cwd, './src'),
        ...opts.alias,
      },
    },
    test: {
      environment: opts.environment ?? 'node',
      include: opts.include ?? ['src/**/*.spec.ts'],
      setupFiles: opts.setupFiles,
      globals: false,
      // Memory: half the cores at most (the default takes them all, next to the other sessions and apps of the machine).
      maxWorkers: '50%',
    },
  }) as UserConfig
}
