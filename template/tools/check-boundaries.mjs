/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Boundary checker: a module listed as "allowed" (public) may only import other
 * allowed modules. Zero npm dependencies.
 *
 * Layouts:
 *   --root <dir> --stack-dirs nest,react     <root>/<stack>/<module>/**   (new repos)
 *   --modules-dir <dir> --stack nest|react   <dir>/<module>/**            (legacy flat repos)
 * Options:
 *   --allowed <file.json>   { "nest": ["common", ...], "react": [...] }  (process substitution ok)
 *   --report                list every inter-module edge (exit 0)
 *   --check-manifests       check <stack>/<module>/module.json of every module against the real imports
 *                           (missing manifest, bad schema, import not in `requires` = error; unused `requires` = warning)
 *     --visibility public|private   the visibility every manifest of this repository must declare
 *     --external <file.json>        modules living in the OTHER repository ({ "nest": [...], "react": [...] }),
 *                                   accepted as `requires` targets (private repo: the public module list)
 *     --strict-requires             unused `requires` become errors
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const SPEC_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // broken symlink
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Extract import specifiers with their 1-based line number (comment lines skipped). */
export function extractSpecifiers(text) {
  const lines = text.split('\n');
  const starts = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  const lineOf = (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const found = [];
  for (const m of text.matchAll(SPEC_RE)) {
    const line = lineOf(m.index);
    if (/^\s*(\/\/|\*|\/\*)/.test(lines[line])) continue;
    found.push({ spec: m[2], line: line + 1 });
  }
  return found;
}

/** Resolve a specifier to `{ module, rest }` of the shared module it targets, or null. */
export function resolveTarget(spec, fileDir, stackRoot, ownModule) {
  const shared = spec.match(/(?:^|\/)modules_shared\/([\w.-]+)(?:\/(.*))?$/);
  if (shared) return shared[1] === ownModule ? null : { module: shared[1], rest: shared[2] ?? '' };
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(fileDir, spec);
  const rel = path.relative(stackRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const [mod, ...rest] = rel.split(path.sep);
  if (!mod || mod === ownModule || !isDir(path.join(stackRoot, mod))) return null;
  return { module: mod, rest: rest.join('/') };
}

/** Collect all inter-module edges of one stack root (a dir whose children are modules). */
export function collectEdges(stackRoot, stack) {
  const edges = [];
  for (const mod of readdirSync(stackRoot).sort()) {
    const modDir = path.join(stackRoot, mod);
    if (SKIP_DIRS.has(mod) || !isDir(modDir)) continue;
    for (const file of walk(modDir)) {
      for (const { spec, line } of extractSpecifiers(readFileSync(file, 'utf8'))) {
        const t = resolveTarget(spec, path.dirname(file), stackRoot, mod);
        if (!t) continue;
        edges.push({
          stack, from: mod, file: path.relative(modDir, file), line,
          to: t.module, rest: t.rest, exists: isDir(path.join(stackRoot, t.module)),
        });
      }
    }
  }
  return edges;
}

/** Edges breaking the rule: allowed module -> non-allowed or absent module. */
export function findViolations(edges, allowed) {
  return edges.filter((e) => {
    const ok = allowed[e.stack] ?? [];
    return ok.includes(e.from) && (!ok.includes(e.to) || !e.exists);
  });
}

export const MANIFEST_FILE = 'module.json';
export const MANIFEST_CATEGORIES = ['core', 'users', 'business', 'ai', 'content', 'other'];
const QUESTION_TYPES = ['confirm', 'select', 'multiselect', 'text'];
const MANIFEST_KEYS = ['id', 'title', 'description', 'visibility', 'category', 'requires', 'env', 'questions'];

/** Schema errors of one parsed manifest (empty array = valid). */
export function validateManifest(manifest, dirName, visibility) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest must be a JSON object'];
  for (const key of MANIFEST_KEYS) if (!(key in manifest)) errors.push(`missing key "${key}"`);
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.includes(key)) errors.push(`unknown key "${key}"`);
  if (manifest.id !== dirName) errors.push(`id "${manifest.id}" must equal the directory name "${dirName}"`);
  for (const key of ['title', 'description']) {
    if (key in manifest && (typeof manifest[key] !== 'string' || !manifest[key].trim())) errors.push(`"${key}" must be a non-empty string`);
  }
  if (!['public', 'private'].includes(manifest.visibility)) errors.push('visibility must be "public" or "private"');
  else if (visibility && manifest.visibility !== visibility) errors.push(`visibility "${manifest.visibility}" but this repository is ${visibility}`);
  if (!MANIFEST_CATEGORIES.includes(manifest.category)) errors.push(`category must be one of ${MANIFEST_CATEGORIES.join(' | ')}`);
  for (const key of ['requires', 'env', 'questions']) {
    if (key in manifest && !Array.isArray(manifest[key])) errors.push(`"${key}" must be an array`);
  }
  if (Array.isArray(manifest.requires)) {
    if (!manifest.requires.every((r) => typeof r === 'string')) errors.push('"requires" must contain strings');
    if (manifest.requires.includes(dirName)) errors.push('a module cannot require itself');
    if (new Set(manifest.requires).size !== manifest.requires.length) errors.push('duplicate entry in "requires"');
  }
  if (Array.isArray(manifest.questions)) {
    manifest.questions.forEach((q, i) => {
      const ok = q && typeof q.id === 'string' && typeof q.prompt === 'string' && QUESTION_TYPES.includes(q.type);
      if (!ok) errors.push(`questions[${i}] needs a string id, a string prompt and a type among ${QUESTION_TYPES.join(' | ')}`);
    });
  }
  if (Array.isArray(manifest.env) && !manifest.env.every((v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]*$/.test(v))) {
    errors.push('"env" entries must be UPPER_SNAKE_CASE variable names');
  }
  return errors;
}

/**
 * Compare every module.json of the given stack roots with the real imports.
 * @param {{stack: string, dir: string}[]} roots
 * @param {object[]} edges from collectEdges
 * @param {{visibility?: string, external?: Record<string,string[]>, strictRequires?: boolean}} [options]
 * @returns {{errors: string[], warnings: string[], manifests: number}}
 */
export function checkManifests(roots, edges, options = {}) {
  const { visibility, external = {}, strictRequires = false } = options;
  const errors = [];
  const warnings = [];
  let manifests = 0;
  for (const { stack, dir } of roots) {
    const modules = readdirSync(dir).filter((name) => !SKIP_DIRS.has(name) && isDir(path.join(dir, name))).sort();
    const known = new Set([...modules, ...(external[stack] ?? [])]);
    for (const mod of modules) {
      const label = `${stack}/${mod}/${MANIFEST_FILE}`;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(path.join(dir, mod, MANIFEST_FILE), 'utf8'));
      } catch (error) {
        errors.push(`${label}: ${error.code === 'ENOENT' ? 'missing manifest' : `invalid JSON (${error.message})`}`);
        continue;
      }
      manifests++;
      const schemaErrors = validateManifest(manifest, mod, visibility);
      for (const message of schemaErrors) errors.push(`${label}: ${message}`);
      if (schemaErrors.length) continue;
      const imported = new Set();
      for (const e of edges.filter((x) => x.stack === stack && x.from === mod)) {
        if (known.has(e.to)) imported.add(e.to);
        else warnings.push(`${stack}/${mod}/${e.file}:${e.line} imports "${e.to}", which exists in no repository (not in requires)`);
      }
      for (const req of manifest.requires) if (!known.has(req)) errors.push(`${label}: requires unknown module "${req}"`);
      for (const used of [...imported].sort()) {
        if (!manifest.requires.includes(used)) errors.push(`${label}: imports "${used}" but it is not listed in requires`);
      }
      for (const req of manifest.requires) {
        if (known.has(req) && !imported.has(req)) {
          (strictRequires ? errors : warnings).push(`${label}: requires "${req}" but never imports it`);
        }
      }
    }
  }
  return { errors, warnings, manifests };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function stackRoots(args) {
  if (args['modules-dir']) {
    if (!['nest', 'react'].includes(args.stack)) throw new Error('--stack nest|react required with --modules-dir');
    return [{ stack: args.stack, dir: path.resolve(args['modules-dir']) }];
  }
  if (args.root) {
    const stacks = String(args['stack-dirs'] || 'nest,react').split(',').filter(Boolean);
    return stacks
      .map((stack) => ({ stack, dir: path.resolve(args.root, stack) }))
      .filter((r) => isDir(r.dir));
  }
  throw new Error('usage: --root <dir> --stack-dirs nest,react | --modules-dir <dir> --stack nest|react  [--allowed f.json] [--report]');
}

function printReport(edges) {
  const groups = new Map();
  for (const e of edges) {
    const k = `${e.stack}\t${e.from}`;
    if (!groups.has(k)) groups.set(k, new Map());
    const files = groups.get(k);
    if (!files.has(e.file)) files.set(e.file, new Set());
    files.get(e.file).add(`${e.to}/${e.rest}`);
  }
  for (const [k, files] of groups) {
    const [stack, mod] = k.split('\t');
    console.log(`${stack} ${mod}:`);
    for (const f of [...files.keys()].sort()) console.log(`  ${f}: ${[...files.get(f)].sort().join(', ')}`);
  }
  const pairs = new Set(edges.map((e) => `${e.stack}: ${e.from} -> ${e.to}`));
  console.log(`\n${edges.length} edge(s), ${pairs.size} module pair(s):`);
  for (const p of [...pairs].sort()) console.log(`  ${p}`);
}

function runManifestCheck(args, roots, edges) {
  const visibility = ['public', 'private'].includes(args.visibility) ? args.visibility : undefined;
  const external = args.external ? JSON.parse(readFileSync(args.external, 'utf8')) : {};
  const { errors, warnings, manifests } = checkManifests(roots, edges, {
    visibility,
    external,
    strictRequires: Boolean(args['strict-requires']),
  });
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) console.log(`error: ${e}`);
  console.log(`\n[check-boundaries] manifests: ${manifests} checked, ${errors.length} error(s), ${warnings.length} warning(s).`);
  return errors.length ? 1 : 0;
}

export function main(argv) {
  const args = parseArgs(argv);
  const roots = stackRoots(args);
  const edges = roots.flatMap((r) => collectEdges(r.dir, r.stack));
  const allowed = args.allowed ? JSON.parse(readFileSync(args.allowed, 'utf8')) : null;
  if (args['check-manifests']) return runManifestCheck(args, roots, edges);
  if (args.report) {
    printReport(edges);
    return 0;
  }
  if (!allowed) throw new Error('--allowed <file.json> is required (or use --report)');
  const bad = findViolations(edges, allowed);
  for (const e of bad) {
    console.log(`${e.stack}/${e.from}/${e.file}:${e.line} → ${e.to}/${e.rest}${e.exists ? '' : ' (module absent)'}`);
  }
  console.log(`\n[check-boundaries] ${bad.length} violation(s) across ${edges.length} inter-module edge(s).`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`[check-boundaries] ✖ ${error.message}`);
    process.exitCode = 2;
  }
}
