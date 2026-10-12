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
  const { libRoots, readSharedModules, resolveModule } = await import('../scripts/lib-roots.mjs');
  const { mergeJestConfig, readLocalJest } = await import('../scripts/merge-jest.mjs');
  const stackDir = process.cwd();
  const linked = readSharedModules(path.join(stackDir, '..'), 'back');
  const libDirs = linked
    ? linked.flatMap((name) => resolveModule('back', stackDir, name)?.dir ?? [])
    : libRoots('back', stackDir).map((root) => root.dir);
  const shared = {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: path.join(stackDir, 'src'),
    testRegex: '.*\\.spec\\.ts$',
    transform: { '^.+\\.(t|j)s$': 'ts-jest' },
    collectCoverageFrom: ['**/*.(t|j)s'],
    coverageDirectory: '../coverage',
    testEnvironment: 'node',
    roots: ['<rootDir>', ...libDirs],
    transformIgnorePatterns: ['node_modules/(?!(.*/)?(@noble|@scure)/)'],
    moduleNameMapper: { '^src/(.*)$': '<rootDir>/$1' },
    setupFiles: ['<rootDir>/test-setup.ts'],
  };
  return mergeJestConfig(shared, readLocalJest(stackDir));
};
