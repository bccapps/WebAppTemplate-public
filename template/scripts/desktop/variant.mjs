/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Desktop VARIANT of a project: the same application built with another set of shared modules, so that an app which
 * uses the `user` module (and PostgreSQL) in its web version can still ship a standalone desktop app (no `user`,
 * SQLite, local trust) without changing its web build.
 *
 * Declared in `project.config.json`:
 *
 *   "desktop": { "enabled": true, ..., "variant": {
 *       "sharedModules": "shared-modules.desktop.json",                       // same format as shared-modules.json
 *       "packageLocal": { "back": "back/package.local.desktop.json" },         // optional overlays merged onto package.local.json
 *       "prune": ["back/src/modules/app/llm"]                                  // optional folders deleted from the staged sources
 *   } }                                                                        //   (code that needs a module the variant does not ship)
 *
 * `<stack>/package.local.desktop.json` is picked up as the overlay of that stack when it exists (no declaration needed).
 * The same fields can live in a descriptor file instead (`"variant": { "descriptor": "desktop-flavor.json" }`, or no project
 * config at all: a `desktop-flavor.json` at the project root is found by convention). Explicit fields win over the descriptor.
 *
 * `stageVariant` builds an ISOLATED copy of the project under `desktop/build/variant/` (gitignored): sources, a copy of the
 * libraries, a `shared-modules.json` made of the variant list, its own generated `package.json` and `node_modules`. The
 * developer's tree (symlinks of `src/modules_shared`, `package.json`, `node_modules`, `.env*`) is never touched.
 *
 * CLI:  node scripts/desktop/variant.mjs describe [--root <dir>]   (prints the variant's module list file, nothing when there is none)
 *       node scripts/desktop/variant.mjs check [--root <dir>]
 *       node scripts/desktop/variant.mjs stage [--root <dir>] [--out <dir>] [--no-install] [--no-build] [--update-lock] [--clean]
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveModule } from '../lib-roots.mjs';

export const STACKS = { back: { key: 'nestcommon' }, front: { key: 'reactcommon' } };
const STAGE_SUBDIR = path.join('desktop', 'build', 'variant');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A repository-relative path without `..` or absolute parts. */
function relativePath(value, what) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`desktop.variant.${what} must be a non-empty path`);
  const normalized = path.normalize(value.trim());
  if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
    throw new Error(`desktop.variant.${what} must be a path inside the project (got "${value}")`);
  }
  return normalized.split(path.sep).join('/');
}

/**
 * `desktop.variant` of project.config.json -> `{ sharedModules, packageLocal: { back?, front? } }`, or null when absent.
 * A plain string is the shorthand of `{ sharedModules: <string> }`. Throws on an invalid declaration.
 */
export function normalizeVariant(raw) {
  if (raw === undefined || raw === null || raw === false) return null;
  const spec = typeof raw === 'string' ? { sharedModules: raw } : raw;
  if (!isPlainObject(spec)) throw new Error('desktop.variant must be an object { sharedModules, packageLocal?, prune?, descriptor? } or a path');
  if (spec.sharedModules === undefined && spec.descriptor === undefined) throw new Error('desktop.variant needs a "sharedModules" path (or a "descriptor" file that provides it)');
  const packageLocal = {};
  if (spec.packageLocal !== undefined) {
    if (!isPlainObject(spec.packageLocal)) throw new Error('desktop.variant.packageLocal must be an object { back?, front? }');
    for (const [stack, file] of Object.entries(spec.packageLocal)) {
      if (!STACKS[stack]) throw new Error(`desktop.variant.packageLocal: unknown stack "${stack}" (back | front)`);
      packageLocal[stack] = relativePath(file, `packageLocal.${stack}`);
    }
  }
  if (spec.prune !== undefined && !Array.isArray(spec.prune)) throw new Error('desktop.variant.prune must be a list of paths');
  const variant = {
    ...(spec.sharedModules !== undefined ? { sharedModules: relativePath(spec.sharedModules, 'sharedModules') } : {}),
    packageLocal,
    prune: (spec.prune ?? []).map((p, i) => relativePath(p, `prune[${i}]`)),
  };
  if (spec.descriptor !== undefined) variant.descriptor = relativePath(spec.descriptor, 'descriptor');
  return variant;
}

/** File name looked for at the project root when project.config.json declares no variant (and none of its own exists). */
export const DESCRIPTOR_CONVENTION = 'desktop-flavor.json';

/**
 * The variant with its descriptor file merged in (IO): `{ sharedModules, packageLocal, prune, env }`. Explicit fields of the
 * declaration win over the descriptor's; `env` (documentation of what the shell forces) is carried as is. Throws when the
 * descriptor is unreadable or no module list is known.
 */
export function resolveVariant(root, variant) {
  const resolved = resolveDeclared(root, variant);
  // Convention: `<stack>/package.local.desktop.json`, when it exists, is the overlay of that stack (dependencies that the
  // modules the variant drops used to bring: e.g. TanStack Query was provided by the `user` module).
  for (const stack of Object.keys(STACKS)) {
    const conventional = `${stack}/${PACKAGE_LOCAL_CONVENTION}`;
    if (!resolved.packageLocal[stack] && existsSync(path.join(root, conventional))) resolved.packageLocal[stack] = conventional;
  }
  return resolved;
}

export const PACKAGE_LOCAL_CONVENTION = 'package.local.desktop.json';

function resolveDeclared(root, variant) {
  if (!variant.descriptor) {
    if (!variant.sharedModules) throw new Error('desktop.variant has no "sharedModules"');
    return { ...variant, packageLocal: { ...variant.packageLocal }, env: {} };
  }
  const file = path.join(root, variant.descriptor);
  if (!existsSync(file)) throw new Error(`${variant.descriptor} (desktop.variant.descriptor) does not exist`);
  let described;
  try {
    described = normalizeVariant({ ...JSON.parse(readFileSync(file, 'utf8')), descriptor: undefined });
  } catch (error) {
    throw new Error(`${variant.descriptor}: ${error.message}`);
  }
  const env = (() => { try { return JSON.parse(readFileSync(file, 'utf8')).env ?? {}; } catch { return {}; } })();
  const sharedModules = variant.sharedModules ?? described.sharedModules;
  if (!sharedModules) throw new Error(`${variant.descriptor} has no "sharedModules"`);
  return {
    sharedModules,
    packageLocal: { ...described.packageLocal, ...variant.packageLocal },
    prune: [...new Set([...described.prune, ...variant.prune])],
    descriptor: variant.descriptor,
    env: isPlainObject(env) ? env : {},
  };
}

/** `--variant <file>`: a descriptor file when it carries a `sharedModules` path, else the module list file itself. */
export function variantFromFlag(root, file) {
  const rel = relativePath(file, 'variant');
  const full = path.join(root, rel);
  if (existsSync(full)) {
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8'));
      if (isPlainObject(parsed) && typeof parsed.sharedModules === 'string') return { descriptor: rel };
    } catch {
      /* not JSON: reported by variantProblems */
    }
  }
  return { sharedModules: rel };
}

/** The variant declared by `<root>/project.config.json`, or null. */
export function readProjectVariant(root) {
  const file = path.join(root, 'project.config.json');
  const declared = existsSync(file) ? normalizeVariant(JSON.parse(readFileSync(file, 'utf8')).desktop?.variant) : null;
  if (declared) return declared;
  // A project without a (wizard) project.config.json — or without a variant in it — may ship the descriptor by convention.
  return existsSync(path.join(root, DESCRIPTOR_CONVENTION)) ? normalizeVariant({ descriptor: DESCRIPTOR_CONVENTION }) : null;
}

/**
 * Pure check of a variant's module lists. `readManifest(stack, id)` returns the parsed `module.json` of a module (or null).
 * Rules: no `user` module (the shell runs the back in local trust mode, the single administrator being implicit), only
 * modules that support SQLite (`databases` absent, or containing `sqlite`) and every `requires` of a listed module
 * present in the same list.
 */
export function checkVariantModules(sharedModules, readManifest) {
  const errors = [];
  for (const [stack, { key }] of Object.entries(STACKS)) {
    const list = Array.isArray(sharedModules) ? sharedModules : sharedModules?.[key];
    if (!Array.isArray(list) || list.length === 0) {
      if (stack === 'back') errors.push(`the variant has no "${key}" list (the back modules)`);
      continue;
    }
    const ids = list.map(String);
    if (ids.includes('user')) errors.push(`the variant lists the "user" module in ${key}: a desktop variant must not use it (the shell runs the back in local trust mode)`);
    for (const id of ids) {
      const manifest = readManifest(stack, id);
      if (!manifest) continue;
      if (Array.isArray(manifest.databases) && !manifest.databases.includes('sqlite')) {
        errors.push(`module "${id}" (${key}) does not support SQLite (it supports: ${manifest.databases.join(', ')}): drop it from the variant`);
      }
      for (const dep of manifest.requires ?? []) {
        if (!ids.includes(dep)) errors.push(`module "${id}" (${key}) requires "${dep}", which is not in the variant`);
      }
    }
  }
  return errors;
}

/** `readManifest` over the project's mounted libraries (`<root>/<stack>/.libs`); null when a module is not found. */
export function manifestReader(root) {
  return (stack, id) => {
    const found = safeResolve(stack, path.join(root, stack), id);
    if (!found) return null;
    const file = path.join(found.dir, 'module.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
}

function safeResolve(stack, stackDir, id) {
  try {
    return resolveModule(stack, stackDir, id);
  } catch {
    return null;
  }
}

/** Every problem of the variant declared for `root` (file missing/unreadable, module rules); empty when it is usable. */
export function variantProblems(root, declared) {
  let variant;
  try {
    variant = resolveVariant(root, declared);
  } catch (error) {
    return [error.message];
  }
  const file = path.join(root, variant.sharedModules);
  if (!existsSync(file)) return [`${variant.sharedModules} (desktop.variant.sharedModules) does not exist`];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return [`${variant.sharedModules} is not valid JSON: ${error.message}`];
  }
  const errors = checkVariantModules(parsed, manifestReader(root));
  for (const [stack, rel] of Object.entries(variant.packageLocal)) {
    if (!existsSync(path.join(root, rel))) errors.push(`${rel} (desktop.variant.packageLocal.${stack}) does not exist`);
  }
  for (const rel of variant.prune) {
    if (!existsSync(path.join(root, rel))) errors.push(`${rel} (desktop.variant.prune) does not exist`);
  }
  return errors;
}

/** Deep merge: objects are merged, anything else (arrays included) is replaced by the overlay. */
export function mergeDeep(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay === undefined ? base : overlay;
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) out[key] = key in base ? mergeDeep(base[key], value) : value;
  return out;
}

/** Entries of a stack folder that are never copied into the stage. */
export function isExcludedFromStage(name) {
  return ['node_modules', 'dist', 'coverage', '.git', '.libs', 'logs', 'package.json', 'package-lock.json'].includes(name) ||
    name.startsWith('.env') || name.endsWith('.log') || name.endsWith('.tgz');
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${[cmd, ...args].join(' ')}${opts.cwd ? `   (in ${opts.cwd})` : ''}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm', ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args[0] ?? ''} failed (exit ${res.status ?? res.signal})`);
}

/** Copies `from` into `to` following symlinks (config-links.json files, libraries), skipping what must not travel. */
function copyStackSources(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (isExcludedFromStage(entry.name)) continue;
    const target = path.join(to, entry.name);
    rmSync(target, { recursive: true, force: true });
    cpSync(path.join(from, entry.name), target, {
      recursive: true,
      dereference: true,
      // The shared modules of the developer's tree (gitignored symlinks) are regenerated by link-shared in the stage.
      filter: (src) => {
        const rel = path.relative(from, src);
        if (rel.split(path.sep)[0] === 'src' && rel.split(path.sep)[1] === 'modules_shared' && rel.split(path.sep).length === 3) {
          return !lstatSync(src).isSymbolicLink();
        }
        return !isExcludedNested(rel);
      },
    });
  }
}

function isExcludedNested(rel) {
  return rel.split(path.sep).some((part) => part === 'node_modules' || part === '.git' || part.startsWith('.env'));
}

/** Real copy of the library checkouts of a stack (Node resolves dependencies from the real path of a file). */
function copyLibs(srcStack, dstStack) {
  const libs = path.join(srcStack, '.libs');
  if (!existsSync(libs)) throw new Error(`${libs} not found: mount the shared libraries first (scripts/update_common.sh --pull-only)`);
  const out = path.join(dstStack, '.libs');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const entry of readdirSync(libs, { withFileTypes: true })) {
    if (entry.name === 'apptemplate') continue; // an alias of vx-public/template, recreated below
    const real = realpathSync(path.join(libs, entry.name));
    cpSync(real, path.join(out, entry.name), { recursive: true, dereference: true, filter: (src) => !isExcludedNested(path.relative(real, src)) });
  }
  const template = existsSync(path.join(out, 'vx-public', 'template')) ? path.join('vx-public', 'template') : null;
  if (template) {
    // Same layout as the project: `.libs/apptemplate` is a symlink to `vx-public/template`.
    try {
      rmSync(path.join(out, 'apptemplate'), { recursive: true, force: true });
      symlinkRelative(path.join(out, template), path.join(out, 'apptemplate'));
    } catch {
      cpSync(path.join(out, template), path.join(out, 'apptemplate'), { recursive: true });
    }
  }
}

function symlinkRelative(target, linkPath) {
  symlinkSync(path.relative(path.dirname(linkPath), target), linkPath, 'dir');
}

/**
 * Builds (or refreshes) the stage of the variant: returns `{ stageRoot }`. Options: `outDir`, `install` (npm ci/install),
 * `build` (npm run build in each stack), `clean` (start from an empty stage), `updateLock` (copy a freshly generated stage lockfile back as
 * `<stack>/package-lock.desktop.json`).
 */
export function stageVariant(root, declared, { outDir, install = true, build = true, updateLock = false, clean = false } = {}) {
  const problems = variantProblems(root, declared);
  if (problems.length) throw new Error(`desktop variant refused:\n  - ${problems.join('\n  - ')}`);
  const variant = resolveVariant(root, declared);
  const stageRoot = path.resolve(outDir ?? path.join(root, STAGE_SUBDIR));
  console.log(`> staging the desktop variant in ${stageRoot} (shared modules: ${variant.sharedModules})`);
  if (clean) rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });
  writeFileSync(path.join(stageRoot, 'shared-modules.json'), readFileSync(path.join(root, variant.sharedModules)));
  if (existsSync(path.join(root, 'project.config.json'))) writeFileSync(path.join(stageRoot, 'project.config.json'), readFileSync(path.join(root, 'project.config.json')));

  for (const stack of Object.keys(STACKS)) {
    const src = path.join(root, stack);
    if (!existsSync(src)) continue;
    const dst = path.join(stageRoot, stack);
    copyStackSources(src, dst);
    copyLibs(src, dst);
    for (const rel of variant.prune) {
      // Code of the app that needs a module the variant does not ship: removed from the STAGED copy only.
      if (rel.split('/')[0] === stack) rmSync(path.join(stageRoot, rel), { recursive: true, force: true });
    }
    const localFile = path.join(src, 'package.local.json');
    const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, 'utf8')) : {};
    const overlayFile = variant.packageLocal[stack];
    const merged = overlayFile ? mergeDeep(local, JSON.parse(readFileSync(path.join(root, overlayFile), 'utf8'))) : local;
    writeFileSync(path.join(dst, 'package.local.json'), `${JSON.stringify(merged, null, 2)}\n`);
    const desktopLock = path.join(src, 'package-lock.desktop.json');
    const hasLock = existsSync(desktopLock);
    if (hasLock) writeFileSync(path.join(dst, 'package-lock.json'), readFileSync(desktopLock));
    run('node', [path.join('.libs', 'apptemplate', 'scripts', 'build-package.mjs'), stack], { cwd: dst });
    if (install) run('npm', hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'], { cwd: dst });
    if (updateLock && existsSync(path.join(dst, 'package-lock.json'))) writeFileSync(desktopLock, readFileSync(path.join(dst, 'package-lock.json')));
    else if (!hasLock && install) console.warn(`WARNING ${stack}/package-lock.desktop.json is missing: the variant's dependencies are not pinned (run stage --update-lock and commit it)`);
  }
  if (build) {
    for (const stack of Object.keys(STACKS)) {
      if (existsSync(path.join(stageRoot, stack))) run('npm', ['run', 'build'], { cwd: path.join(stageRoot, stack) });
    }
  }
  return { stageRoot };
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) opts._.push(arg);
    else if (['no-install', 'no-build', 'update-lock', 'clean'].includes(arg.slice(2))) opts[arg.slice(2)] = true;
    else if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
    else opts[arg.slice(2)] = argv[++i];
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const root = path.resolve(opts.root ?? process.cwd());
  const variant = readProjectVariant(root);
  if (opts._[0] === 'describe') {
    if (variant) console.log(resolveVariant(root, variant).sharedModules);
    return;
  }
  if (!variant) throw new Error(`no desktop variant: declare desktop.variant in project.config.json or provide ${DESCRIPTOR_CONVENTION}`);
  const [command = 'check'] = opts._;
  if (command === 'check') {
    const problems = variantProblems(root, variant);
    if (problems.length) throw new Error(`desktop variant refused:\n  - ${problems.join('\n  - ')}`);
    console.log(`desktop variant OK (${resolveVariant(root, variant).sharedModules})`);
  } else if (command === 'stage') {
    stageVariant(root, variant, { outDir: opts.out, install: !opts['no-install'], build: !opts['no-build'], updateLock: Boolean(opts['update-lock']), clean: Boolean(opts.clean) });
  } else throw new Error(`unknown command "${command}" (check | stage)`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR ${error.message}`);
    process.exit(1);
  }
}
