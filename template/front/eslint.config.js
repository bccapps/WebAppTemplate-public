/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import path from 'node:path'
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { linkedModuleDirs } from '../scripts/lib-roots.mjs'

// Linted: the app sources and the real directories of the LINKED shared modules (shared-modules.json, resolved by
// scripts/lib-roots.mjs like the Jest roots: ESLint does not descend into the `src/modules_shared` links). The rest of
// `.libs/` (other stacks, unlinked modules, tooling) is not part of the app and is never linted.
const stackDir = process.cwd()
const linkedModuleGlobs = linkedModuleDirs('front', stackDir).map((dir) => `${path.relative(stackDir, dir)}/**/*.{ts,tsx}`)

export default tseslint.config(
  // ESLint 10 looks a config up from each file's directory: the template's own configs (reached through its real path,
  // not the `apptemplate` link) must never be picked up.
  // dev-dist: vite-plugin-pwa's dev service worker output (generated, git-ignored).
  { ignores: ['dist', 'dev-dist', '.libs/**/*.{js,jsx,mjs,cjs}', '.libs/vx-public/template/**', '.libs/apptemplate/**'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['*.ts', 'src/**/*.{ts,tsx}', ...linkedModuleGlobs],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Same convention as the back config: a leading underscore marks an intentionally unused binding (interface
      // parameters, rest-sibling omission).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The two classic hooks rules only: the v7 `recommended` preset also turns on the React Compiler rules at error level.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
)
