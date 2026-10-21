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
 *   3. the `package.fragment.json` of each app module (`<stack>/src/modules/<feature>/`), in alphabetical
 *      order of the folder: the dependencies a project feature needs live next to that feature, so removing
 *      the feature removes them
 *   4. the project-local overlay (`<stack>/package.local.json`): only what is project-wide and cannot belong
 *      to a module (overrides, pins, tooling used by project scripts).
 * Later layers win on every key collision, so a project can pin its own dependency
 * versions (and add its domain-specific deps) without forking the shared base.
 * A `jest` key is dropped from the result when `<stack>/jest.config.js` exists
 * (jest refuses multiple configurations).
 *
 * It also generates `<stack>/.env.example` (same model, never edited by hand): the template's
 * `.env.example` filtered to the linked modules' `# @module` blocks, the `env` of their module.json,
 * then the project's `<stack>/.env.example.local` (see renderEnvExample in lib/project-engine.mjs).
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

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import { readSharedModules, resolveModule } from './lib-roots.mjs';
import { loadCatalog, renderEnvExample, resolveModules } from './lib/project-engine.mjs';

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

/** Fragment files of the app's own modules (`<stack>/src/modules/<feature>/package.fragment.json`), sorted by folder. */
function appFragmentFiles(stackDir) {
  const modulesDir = path.join(stackDir, 'src', 'modules');
  if (!existsSync(modulesDir)) return [];
  return readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: `app:${entry.name}`, file: path.join(modulesDir, entry.name, 'package.fragment.json') }))
    .filter(({ file }) => existsSync(file))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Packages that two fragments declare with different specifiers (the later one silently wins in the merge).
 * The base and the local overlay are left out: overriding them is their purpose.
 * @returns {{ pkg: string, versions: { from: string, spec: string }[] }[]}
 */
export function fragmentConflicts(fragments) {
  const seen = new Map();
  for (const { name, file } of fragments) {
    const json = readJson(file);
    for (const depKey of DEP_KEYS) {
      for (const [pkg, spec] of Object.entries(json[depKey] ?? {})) {
        const list = seen.get(pkg) ?? [];
        list.push({ from: name, spec });
        seen.set(pkg, list);
      }
    }
  }
  return [...seen]
    .filter(([, list]) => new Set(list.map((v) => v.spec)).size > 1)
    .map(([pkg, versions]) => ({ pkg, versions }));
}

/**
 * Compute the merged package.json of a stack. Returns null when the base is absent.
 * @param {'back'|'front'} stack
 * @param {string} stackDir absolute path of <project>/<stack>
 * @returns {{ pkg: object, fragments: string[], conflicts: ReturnType<typeof fragmentConflicts> } | null}
 */
export function buildPackage(stack, stackDir) {
  const baseFile = path.join(stackDir, '.libs', 'apptemplate', stack, 'package.base.json');
  const localFile = path.join(stackDir, 'package.local.json');
  if (!existsSync(baseFile)) return null;
  if (!existsSync(localFile)) throw new Error(`${localFile} introuvable — impossible de générer package.json.`);

  const fragments = [...fragmentFiles(stack, stackDir), ...appFragmentFiles(stackDir)];
  let merged = readJson(baseFile);
  for (const { file } of fragments) merged = deepMerge(merged, readJson(file));
  merged = deepMerge(merged, readJson(localFile));
  if (existsSync(path.join(stackDir, 'jest.config.js'))) delete merged.jest;
  return { pkg: canonicalize(merged), fragments: fragments.map((f) => f.name), conflicts: fragmentConflicts(fragments) };
}

/**
 * Content of the generated `<stack>/.env.example`, or null when the template example or the project's
 * shared-modules.json is missing (the file is then left as it is). Unknown module ids are reported, not fatal.
 */
export function buildEnvExample(stack, stackDir) {
  const template = path.join(stackDir, '.libs', 'apptemplate', stack, '.env.example');
  const root = path.resolve(stackDir, '..');
  if (!existsSync(template) || !existsSync(path.join(root, 'shared-modules.json'))) return null;
  const libs = path.join(stackDir, '.libs');
  const catalog = loadCatalog({
    public: path.join(libs, 'vx-public'),
    private: existsSync(path.join(libs, 'vx-private')) ? path.join(libs, 'vx-private') : null,
  });
  const linked = [...new Set([...(readSharedModules(root, 'back') ?? []), ...(readSharedModules(root, 'front') ?? [])])];
  const resolved = resolveModules(catalog, linked.filter((id) => catalog.byId.has(id)));
  const localFile = path.join(stackDir, '.env.example.local');
  const local = existsSync(localFile) ? readFileSync(localFile, 'utf8') : '';
  return renderEnvExample({ template: readFileSync(template, 'utf8'), catalog, resolved, stack, local });
}

const lstatSafe = (file) => {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
};

/** Write `<stack>/.env.example`, replacing the template symlink older projects still have (never write through it). */
export function writeEnvExample(stack, stackDir) {
  const text = buildEnvExample(stack, stackDir);
  if (text === null) return;
  const file = path.join(stackDir, '.env.example');
  if (lstatSafe(file)?.isSymbolicLink()) unlinkSync(file);
  writeFileSync(file, text);
  console.log(`[build-package] ${stack}/.env.example généré.`);
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
  for (const { pkg, versions } of result.conflicts) {
    const detail = versions.map((v) => `${v.from}: ${v.spec}`).join(', ');
    console.warn(`[build-package] ⚠ ${pkg} déclaré avec des versions différentes (${detail}) — la dernière gagne ; l'aligner ou le figer dans package.local.json.`);
  }
  writeFileSync(path.join(stackDir, 'package.json'), JSON.stringify(result.pkg, null, 2) + '\n');

  const depCount = Object.keys(result.pkg.dependencies || {}).length;
  const devCount = Object.keys(result.pkg.devDependencies || {}).length;
  const frag = result.fragments.length ? ` fragments: ${result.fragments.join(', ')};` : ' aucun fragment;';
  console.log(`[build-package] ${stack}/package.json généré (${depCount} deps, ${devCount} devDeps;${frag}).`);

  try {
    writeEnvExample(stack, stackDir);
  } catch (error) {
    console.warn(`[build-package] ⚠ ${stack}/.env.example non régénéré : ${error.message}`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
