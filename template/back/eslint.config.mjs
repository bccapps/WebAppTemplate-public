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
import tseslint from 'typescript-eslint'
import { linkedModuleDirs } from '../scripts/lib-roots.mjs'

// Shared ESLint 10 flat config for every NestJS backend (mirrors
// front/eslint.config.js, kept sober: recommended baseline only, no
// type-aware rules, no exotic plugins).
//
// SYMLINK NOTE: `src/modules_shared/<mod>` is a directory *symlink* into the
// library checkouts under `.libs/` (CLAUDE.md §1b). ESLint's file enumerator
// does NOT descend into symlinked directories when walking `src/**/*.ts`, so
// the real directories of the LINKED modules (shared-modules.json, resolved by
// scripts/lib-roots.mjs like the Jest roots) are listed as their own `files`
// entries: each module is linted once, from its real path. Unlinked modules of
// the libraries are not part of the app and are never linted.
const stackDir = process.cwd()
const linkedModuleGlobs = linkedModuleDirs('back', stackDir).map((dir) => `${path.relative(stackDir, dir)}/**/*.ts`)

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.libs/apptemplate/**',
      // ESLint 10 looks a config up from each file's directory: never the template's own (real path of the link).
      '.libs/vx-public/template/**',
      '**/*.js',
      '**/*.mjs',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/**/*.ts', ...linkedModuleGlobs],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      // NestJS relies heavily on decorator-injected empty constructors and
      // unused decorator parameters (e.g. `@Body() _dto: Dto`).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
