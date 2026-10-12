/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Shared ESLint 9 flat config for every NestJS backend (mirrors
// front/eslint.config.js, kept sober: recommended baseline only, no
// type-aware rules, no exotic plugins).
//
// SYMLINK NOTE: `src/modules_shared/<mod>` is a directory *symlink* into
// `.libs/nestcommon/<mod>` (real source, see CLAUDE.md §1). ESLint's flat
// config file enumerator (`@eslint/eslintrc`/`fast-glob` under the hood)
// does NOT descend into symlinked directories when walking `src/**/*.ts`,
// so those modules would silently be skipped if we only listed `src`.
// We therefore add `.libs/nestcommon/**/*.ts` as its own `files` entry so
// the real files get linted directly (once, from their real path) instead
// of relying on the symlink traversal.
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.libs/apptemplate/**',
      '**/*.js',
      '**/*.mjs',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/**/*.ts', '.libs/nestcommon/**/*.ts'],
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
