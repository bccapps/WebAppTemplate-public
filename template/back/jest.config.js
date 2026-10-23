/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Shared jest configuration for every back/ stack. Linked into each project as
 * `back/jest.config.js` (see config-links.json). Run jest from `back/`.
 *
 * `roots` lists the project sources plus the directory of every module listed in
 * shared-modules.json (vx-public / vx-private / legacy nestcommon), resolved by
 * scripts/lib-roots.mjs — only LINKED modules are tested: the specs of an unlinked module
 * cannot compile (its dependencies are absent). Without a readable shared-modules.json, every
 * existing library root is used (jest fails on a root that does not exist, hence the filtering).
 *
 * App overrides: the `jest` object of `<cwd>/package.local.json` (if any) is deep-merged over this
 * config by scripts/merge-jest.mjs (objects merged, e.g. `moduleNameMapper` / `transform` key by
 * key; arrays and scalars replaced). build-package.mjs drops `jest` from the generated package.json.
 */

const path = require('path');

module.exports = async () => {
  const { linkedModuleDirs } = await import('../scripts/lib-roots.mjs');
  const { mergeJestConfig, readLocalJest } = await import('../scripts/merge-jest.mjs');
  const stackDir = process.cwd();
  const libDirs = linkedModuleDirs('back', stackDir);
  const shared = {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: path.join(stackDir, 'src'),
    testRegex: '.*\\.spec\\.ts$',
    // Type errors of vx-private files are not reported by ts-jest: TypeScript resolves their relative
    // imports of public modules (`../../common/...`) from the real path, where they do not exist
    // (jest-resolver.cjs fixes the runtime side; `nest build` type-checks the sources through the links).
    transform: { '^.+\\.(t|j)s$': ['ts-jest', { diagnostics: { exclude: ['**/.libs/vx-private/**'] } }] },
    collectCoverageFrom: ['**/*.(t|j)s'],
    coverageDirectory: '../coverage',
    testEnvironment: 'node',
    roots: ['<rootDir>', ...libDirs],
    moduleNameMapper: { '^src/(.*)$': '<rootDir>/$1' },
    setupFiles: ['<rootDir>/test-setup.ts'],
    // Memory: with `--experimental-vm-modules` Node keeps every test file's context alive in its worker; Jest's default (cores - 1
    // workers, never restarted) took a 36 GB machine down on 2026-10-23. Half the cores, and a worker past 1 GB is restarted between files.
    maxWorkers: '50%',
    workerIdleMemoryLimit: '1GB',
    // vx-private specs import vx-public modules by relative path: see scripts/jest-resolver.cjs
    resolver: path.join(__dirname, '..', 'scripts', 'jest-resolver.cjs'),
  };
  return mergeJestConfig(shared, readLocalJest(stackDir));
};
