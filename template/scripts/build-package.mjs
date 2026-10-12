/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Generates a project's `package.json` by deep-merging, in this order:
 *   1. the SHARED base (`<stack>/.libs/apptemplate/<stack>/package.base.json`)
 *   2. the `package.fragment.json` of each linked shared module, in the order of
 *      `shared-modules.json` (resolved through lib-roots.mjs)
 *   3. the project-local overlay (`<stack>/package.local.json`).
 * Later layers win on every key collision, so a project can pin its own dependency
 * versions (and add its domain-specific deps) without forking the shared base.
 * A `jest` key is dropped from the result when `<stack>/jest.config.js` exists
 * (jest refuses multiple configurations).
 *
 * Invocation — run from the STACK directory (back/ or front/), which is how the
 * package.json `prebuild`/`postinstall` hooks call it:
 *     node ../scripts/build-package.mjs           # stack = basename(cwd)
 *     node ../scripts/build-package.mjs back       # explicit stack
 *
 * The base is read from the in-repo app-template submodule
 * (`<stack>/.libs/apptemplate/<stack>/package.base.json`) so it resolves on a
 * fresh clone / inside Docker, and is pinned to the project's submodule commit.
 *
 * If the base file is absent (e.g. before the package.base.json migration), the
 * script no-ops so installs never break.
 *
 * Merge rules: plain objects merge recursively; everything else (arrays,
 * scalars) → local replaces base. Output is written with 2-space indent + final
 * newline (npm style) and the result is the generated `package.json`.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import { readSharedModules, resolveModule } from './lib-roots.mjs';

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const sortObject = (obj) =>
  Object.fromEntries(Object.keys(obj).sort().map((key) => [key, obj[key]]));

// Canonical top-level key order; unknown keys keep their merged order at the end.
const KEY_ORDER = [
  'name', 'version', 'description', 'private', 'license', 'type',
  'scripts', 'dependencies', 'devDependencies', 'peerDependencies',
  'optionalDependencies', 'overrides', 'engines', 'jest',
];

export function canonicalize(pkg) {
  for (const depKey of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkg[depKey]) pkg[depKey] = sortObject(pkg[depKey]);
  }
  const ordered = {};
  for (const key of KEY_ORDER) if (key in pkg) ordered[key] = pkg[key];
  for (const key of Object.keys(pkg)) if (!(key in ordered)) ordered[key] = pkg[key];
  return ordered;
}

/** Fragment files of the linked modules, in shared-modules.json order. */
function fragmentFiles(stack, stackDir) {
  const modules = readSharedModules(path.resolve(stackDir, '..'), stack) ?? [];
  const files = [];
  for (const name of modules) {
    const found = resolveModule(stack, stackDir, name);
    const file = found && path.join(found.dir, 'package.fragment.json');
    if (file && existsSync(file)) files.push({ name, file });
  }
  return files;
}

/**
 * Compute the merged package.json of a stack. Returns null when the base is absent.
 * @param {'back'|'front'} stack
 * @param {string} stackDir absolute path of <project>/<stack>
 * @returns {{ pkg: object, fragments: string[] } | null}
 */
export function buildPackage(stack, stackDir) {
  const baseFile = path.join(stackDir, '.libs', 'apptemplate', stack, 'package.base.json');
  const localFile = path.join(stackDir, 'package.local.json');
  if (!existsSync(baseFile)) return null;
  if (!existsSync(localFile)) throw new Error(`${localFile} introuvable — impossible de générer package.json.`);

  const fragments = fragmentFiles(stack, stackDir);
  let merged = readJson(baseFile);
  for (const { file } of fragments) merged = deepMerge(merged, readJson(file));
  merged = deepMerge(merged, readJson(localFile));
  if (existsSync(path.join(stackDir, 'jest.config.js'))) delete merged.jest;
  return { pkg: canonicalize(merged), fragments: fragments.map((f) => f.name) };
}

function main() {
  const stackDir = process.cwd();
  const stack = process.argv[2] || path.basename(stackDir);
  let result;
  try {
    result = buildPackage(stack, stackDir);
  } catch (error) {
    console.error(`[build-package] ✖ ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!result) {
    console.log(`[build-package] base absente (.libs/apptemplate/${stack}/package.base.json) — package.json laissé tel quel.`);
    return;
  }
  writeFileSync(path.join(stackDir, 'package.json'), JSON.stringify(result.pkg, null, 2) + '\n');

  const depCount = Object.keys(result.pkg.dependencies || {}).length;
  const devCount = Object.keys(result.pkg.devDependencies || {}).length;
  const frag = result.fragments.length ? ` fragments: ${result.fragments.join(', ')};` : ' aucun fragment;';
  console.log(`[build-package] ${stack}/package.json généré (${depCount} deps, ${devCount} devDeps;${frag}).`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
