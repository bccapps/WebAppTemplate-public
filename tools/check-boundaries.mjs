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

export function main(argv) {
  const args = parseArgs(argv);
  const edges = stackRoots(args).flatMap((r) => collectEdges(r.dir, r.stack));
  const allowed = args.allowed ? JSON.parse(readFileSync(args.allowed, 'utf8')) : null;
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
