/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Single source of truth for locating shared library modules of a project.
 *
 * Supported layouts (checked in this order):
 *   1. `<stack>/.libs/vx-public/<nest|react>/<module>`
 *   2. `<stack>/.libs/vx-private/<nest|react>/<module>`
 *   3. legacy: `<stack>/.libs/nestcommon/<module>` (back) | `<stack>/.libs/reactcommon/<module>` (front)
 *
 * A module present in both vx-public and vx-private is a configuration error.
 * Zero dependencies, ESM. (front/libRoots.ts mirrors libRoots(): keep both in sync.)
 */

import { readFileSync, statSync } from 'fs';
import path from 'path';

const STACKS = {
  back: { kind: 'nest', legacy: 'nestcommon', key: 'nestcommon' },
  front: { kind: 'react', legacy: 'reactcommon', key: 'reactcommon' },
};

function stackInfo(stack) {
  const info = STACKS[stack];
  if (!info) throw new Error(`unknown stack "${stack}" (expected back|front)`);
  return info;
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Existing library roots of a stack, in resolution order.
 * @param {'back'|'front'} stack
 * @param {string} stackDir absolute path of <project>/<stack>
 * @returns {{ name: 'vx-public'|'vx-private'|'legacy', dir: string }[]}
 */
export function libRoots(stack, stackDir) {
  const { kind, legacy } = stackInfo(stack);
  const libs = path.join(stackDir, '.libs');
  return [
    { name: 'vx-public', dir: path.join(libs, 'vx-public', kind) },
    { name: 'vx-private', dir: path.join(libs, 'vx-private', kind) },
    { name: 'legacy', dir: path.join(libs, legacy) },
  ].filter((root) => isDir(root.dir));
}

/**
 * Locate one module. Throws when it exists in both vx-public and vx-private.
 * @returns {{ dir: string, origin: string } | null}
 */
export function resolveModule(stack, stackDir, moduleName) {
  const hits = libRoots(stack, stackDir)
    .map((root) => ({ dir: path.join(root.dir, moduleName), origin: root.name }))
    .filter((hit) => isDir(hit.dir));
  const names = hits.map((h) => h.origin);
  if (names.includes('vx-public') && names.includes('vx-private')) {
    throw new Error(`module "${moduleName}" exists in both vx-public and vx-private (${stack}) — remove one.`);
  }
  return hits[0] ?? null;
}

/**
 * Read the module list of a stack from `<projectRoot>/shared-modules.json`
 * (key nestcommon | reactcommon; a plain array is also accepted).
 * @param {(reason: string) => void} [onProblem] called with a human reason when null is returned
 * @returns {string[] | null}
 */
export function readSharedModules(projectRoot, stack, onProblem) {
  const { key } = stackInfo(stack);
  const file = path.join(projectRoot, 'shared-modules.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const why = error?.code === 'ENOENT' ? 'introuvable' : `illisible (${error.message})`;
    onProblem?.(`${file} ${why}`);
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.[key];
  if (!Array.isArray(list) || !list.length) {
    onProblem?.(`${file} ne contient pas de liste "${key}" non vide`);
    return null;
  }
  return list.map(String);
}

/**
 * Real directories of the shared modules a stack links (shared-modules.json), for the tools that must reach the
 * library sources themselves (Jest roots, ESLint files): they do not descend into the `src/modules_shared` links.
 * Without a readable shared-modules.json, every existing library root.
 * @returns {string[]} absolute directories
 */
export function linkedModuleDirs(stack, stackDir) {
  const linked = readSharedModules(path.dirname(stackDir), stack);
  return linked
    ? linked.flatMap((name) => resolveModule(stack, stackDir, name)?.dir ?? [])
    : libRoots(stack, stackDir).map((root) => root.dir);
}

export function hasModule(projectRoot, stack, name) {
  return readSharedModules(projectRoot, stack)?.includes(name) ?? false;
}

