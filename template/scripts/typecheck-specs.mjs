/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * `npm run typecheck:specs`: type-checks the specs of a stack with `tsc -p tsconfig.spec.json` (ts-jest and Vitest
 * only transpile them).
 *
 * A folder of `src/` that is a link into the OTHER stack (e.g. a front folder linked to back engine code) holds that
 * stack's specs: they resolve its own packages and aliases, and its own run checks them. Such links are excluded
 * through a generated config (`node_modules/.tmp/tsconfig.spec.json`, extending the stack's tsconfig.spec.json);
 * without any, tsconfig.spec.json is used as it is.
 *
 * Invocation — from the STACK directory (back/ or front/):
 *     node .libs/apptemplate/scripts/typecheck-specs.mjs <stack>
 */

import { spawnSync } from 'child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const OTHER = { back: 'front', front: 'back' };

/** Relative paths (from the stack dir, posix) of the links under `src/` whose target is inside the other stack. */
export function crossStackLinks(stackDir, stack) {
  const other = OTHER[stack];
  if (!other) throw new Error(`unknown stack "${stack}" (back | front)`);
  const otherRoot = realpathSync(path.resolve(stackDir, '..', other));
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = realpathSync(full);
        } catch {
          continue; // dangling link
        }
        if (lstatSync(target).isDirectory() && (target + path.sep).startsWith(otherRoot + path.sep)) {
          found.push(path.relative(stackDir, full).split(path.sep).join('/'));
        }
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  const src = path.join(stackDir, 'src');
  try {
    walk(src);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return found.sort();
}

/** tsconfig.spec.json without its `//` comment lines (the file is JSONC). */
export function readSpecConfig(stackDir) {
  const text = readFileSync(path.join(stackDir, 'tsconfig.spec.json'), 'utf8');
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
}

/** Generated config (relative to `node_modules/.tmp/`) excluding the cross-stack links on top of the base excludes. */
export function generatedSpecConfig(base, links) {
  const up = (p) => `../../${p}`;
  return {
    extends: '../../tsconfig.spec.json',
    include: (base.include ?? []).map(up),
    exclude: [...(base.exclude ?? []), ...links.map((link) => `${link}/**`)].map(up),
  };
}

function main() {
  const stackDir = process.cwd();
  const stack = process.argv[2] || path.basename(stackDir);
  const links = crossStackLinks(stackDir, stack);
  let project = 'tsconfig.spec.json';
  if (links.length) {
    const dir = path.join(stackDir, 'node_modules', '.tmp');
    mkdirSync(dir, { recursive: true });
    project = path.join(dir, 'tsconfig.spec.json');
    writeFileSync(project, `${JSON.stringify(generatedSpecConfig(readSpecConfig(stackDir), links), null, 2)}\n`);
    console.log(`[typecheck-specs] ${stack}: left to the ${OTHER[stack]} run (links into it): ${links.join(', ')}`);
  }
  const result = spawnSync('npx', ['tsc', '-p', project], { cwd: stackDir, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
