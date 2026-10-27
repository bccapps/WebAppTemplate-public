/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Theme-colors audit — enforces the « no color literal in a component or its CSS » rule (template CLAUDE.md,
 * « Themes & styles »): a color is read from a token (`var(--…)`, defined in `common/theme/tokens.css` or the
 * module's `styles/tokens.css`) and overridden by the theme, never written in the component.
 *
 * Scans the app's own sources (`front/src`, plus `extraSourceDirs`): `.ts` `.tsx` `.css` `.scss`. The linked shared
 * modules (`src/modules_shared`, symlinks) are the library's and are not scanned.
 *
 * A literal is `#rgb` `#rrggbb` `#rrggbbaa`, `rgb()` `rgba()` `hsl()` `hsla()` (a `rgba(var(--x-rgb), .3)` is not one).
 *
 * Never counted:
 *   - token files (`tokens.css`) and the app's theme folder (`front/src/themes/`): the only places for literals
 *   - specs and tests, comments
 *   - the FALLBACK of a `var(--token, <fallback>)`
 *   - a line carrying `theme-colors-ignore`, or following a line that does (data colors: chart series, avatar
 *     palettes, user-picked colors; canvas/pixel-art engines and terminal palettes: use the file or path ignore)
 *   - a file carrying `theme-colors-ignore-file` in its first 40 lines (below the license header)
 *
 * Usage (from repo root, or from front/):
 *     node .libs/apptemplate/scripts/check-theme-colors.mjs                     report, exit 0
 *     node .libs/apptemplate/scripts/check-theme-colors.mjs --check             CI: exit 1 on a literal
 *     node .libs/apptemplate/scripts/check-theme-colors.mjs --json              machine-readable output
 *     node .libs/apptemplate/scripts/check-theme-colors.mjs --update-baseline   record today's counts per file
 *     node .libs/apptemplate/scripts/check-theme-colors.mjs --root DIR          force scan root
 *
 * Optional `.themecolorsrc.json` at the scan root:
 *   { "ignore": ["^front/src/modules/game/engine/"],   // path regexes, relative to the root, `/` separators
 *     "extraSourceDirs": [] }
 * Optional `.themecolors-baseline.json` (written by --update-baseline): `{ "<file>": <count> }`. With a baseline,
 * `--check` fails only on a file that EXCEEDS its recorded count (adopting the rule in a legacy app: no new literal,
 * the old ones are paid down file by file; lower the numbers by re-running --update-baseline).
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const SOURCE_EXT = new Set(['.ts', '.tsx', '.css', '.scss']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dev-dist', 'build', '.git', 'coverage', '.turbo', '.cache']);
const IGNORE_MARK = 'theme-colors-ignore';
const IGNORE_FILE_MARK = 'theme-colors-ignore-file';
const FILE_MARK_LINES = 40; // below the license header

// A functional notation counts only when it opens with a value: `rgba(var(--x-rgb), .3)` is token-driven.
const LITERAL_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])|\b(?:rgba?|hsla?)\(\s*(?!var\()/g;

/** Replace every character but newlines by a space (keeps line/column positions). */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/** Blank the comments of a source (block comments, and `//` comments in TS). */
function stripComments(text, ext) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (ext === '.ts' || ext === '.tsx' || ext === '.scss') {
    out = out.replace(/(^|[\s;,{}()])\/\/.*$/gm, (m, lead) => lead + blank(m.slice(lead.length)));
  }
  return out;
}

/** Blank the fallback of every `var(--token, <fallback>)` (nested parentheses and nested `var()` included). */
function stripVarFallbacks(text) {
  const out = text.split('');
  const re = /var\(\s*--[\w-]+\s*,/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + 4;
    const start = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    const end = depth === 0 ? i - 1 : text.length;
    for (let k = start; k < end; k++) if (out[k] !== '\n') out[k] = ' ';
    re.lastIndex = end;
  }
  return out.join('');
}

/**
 * Literals of one source: `[{ line, col, text }]`. `ext` is the file extension (`.css`, `.tsx`…).
 * In CSS a `#abc` before a `{` or a `,` is an id selector, not a color.
 */
export function findLiterals(source, ext) {
  if (source.split('\n', FILE_MARK_LINES).some((l) => l.includes(IGNORE_FILE_MARK))) return [];
  const rawLines = source.split('\n');
  const lines = stripVarFallbacks(stripComments(source, ext)).split('\n');
  const found = [];
  let depth = 0; // CSS: `{` nesting at the start of the line (a `#abc` outside a block is an id selector)
  lines.forEach((line, idx) => {
    const depthAtStart = depth;
    for (const ch of line) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
    if (rawLines[idx].includes(IGNORE_MARK) || (idx > 0 && rawLines[idx - 1].includes(IGNORE_MARK))) return;
    LITERAL_RE.lastIndex = 0;
    let m;
    while ((m = LITERAL_RE.exec(line))) {
      if (m[0][0] === '#') {
        if (ext === '.css' || ext === '.scss') {
          const before = line.slice(0, m.index);
          const after = line.slice(m.index + m[0].length);
          const opens = (before.match(/{/g) || []).length - (before.match(/}/g) || []).length;
          if (depthAtStart + opens <= 0 || /^\s*\{/.test(after)) continue; // an id selector (outside a block, or a nested rule), not a value
        } else if (/[&\w/]$/.test(line.slice(0, m.index)) || /^&#/.test(line.slice(m.index - 1))) {
          continue; // `&#xFF;` entity, `/#/`, `a#b`
        }
      }
      found.push({ line: idx + 1, col: m.index + 1, text: m[0] });
    }
  });
  return found;
}

function findRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'front'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

const toPosix = (p) => p.split(path.sep).join('/');

/** Is this file never audited (token file, app theme folder, spec/test, declaration)? */
export function isExempt(rel) {
  const base = path.posix.basename(rel);
  return (
    base === 'tokens.css' ||
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(base) ||
    base.endsWith('.d.ts') ||
    rel.startsWith('front/src/themes/') ||
    /(^|\/)__(tests|mocks|fixtures)__\//.test(rel)
  );
}

function walk(dir, onFile) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue; // modules_shared & co: the library's, not the app's
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, onFile); } else if (e.isFile()) onFile(full);
  }
}

/** Audit a project root: `{ files: { <rel>: [{ line, col, text }] }, total }`. */
export function audit(root, { ignore = [], extraSourceDirs = [] } = {}) {
  const ignoreRes = ignore.map((r) => new RegExp(r));
  const dirs = [path.join(root, 'front/src'), ...extraSourceDirs.map((d) => path.resolve(root, d))].filter(existsSync);
  const files = {};
  let total = 0;
  for (const dir of dirs) {
    walk(dir, (full) => {
      const ext = path.extname(full);
      if (!SOURCE_EXT.has(ext)) return;
      const rel = toPosix(path.relative(root, full));
      if (isExempt(rel) || ignoreRes.some((re) => re.test(rel))) return;
      const hits = findLiterals(readFileSync(full, 'utf8'), ext);
      if (hits.length) { files[rel] = hits; total += hits.length; }
    });
  }
  return { files, total };
}

/** Files exceeding their baseline count (a file absent from the baseline has 0): `[{ file, count, allowed }]`. */
export function overBaseline(files, baseline = {}) {
  return Object.entries(files)
    .filter(([file, hits]) => hits.length > (baseline[file] ?? 0))
    .map(([file, hits]) => ({ file, count: hits.length, allowed: baseline[file] ?? 0 }));
}

function readJson(file, label) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    console.error(`[check-theme-colors] ⚠ ${label} unreadable: ${e.message}`);
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  if (has('--help') || has('-h')) {
    console.log(`Theme-colors audit — color literals (#hex, rgb(), hsl()) in the app's components and CSS.

Usage (from repo root, or from front/):
  node .libs/apptemplate/scripts/check-theme-colors.mjs                    report, exit 0
  node .libs/apptemplate/scripts/check-theme-colors.mjs --check            CI: exit 1 on a literal (over the baseline if any)
  node .libs/apptemplate/scripts/check-theme-colors.mjs --json             machine-readable output
  node .libs/apptemplate/scripts/check-theme-colors.mjs --update-baseline  record the per-file counts
  node .libs/apptemplate/scripts/check-theme-colors.mjs --root D           force scan root

Config: .themecolorsrc.json { "ignore": ["^front/src/…"], "extraSourceDirs": [] }; baseline: .themecolors-baseline.json.
In a source: a line with \`theme-colors-ignore\` (or the line after it) and a file with \`theme-colors-ignore-file\` in its first lines are skipped.`);
    return;
  }
  const root = path.resolve(opt('--root', findRoot(process.cwd())));
  const cfg = readJson(path.join(root, '.themecolorsrc.json'), '.themecolorsrc.json') || {};
  const baselinePath = path.join(root, '.themecolors-baseline.json');
  const { files, total } = audit(root, cfg);

  if (has('--update-baseline')) {
    const counts = Object.fromEntries(Object.entries(files).map(([f, h]) => [f, h.length]).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`[check-theme-colors] baseline written: ${total} literal(s) in ${Object.keys(counts).length} file(s) -> ${path.basename(baselinePath)}`);
    return;
  }

  const baseline = readJson(baselinePath, '.themecolors-baseline.json');
  const over = baseline ? overBaseline(files, baseline) : Object.entries(files).map(([file, hits]) => ({ file, count: hits.length, allowed: 0 }));
  if (has('--json')) {
    console.log(JSON.stringify({ total, files, over }, null, 2));
  } else if (total === 0) {
    console.log('[check-theme-colors] ✓ no color literal outside the token files and themes');
  } else {
    const shown = new Set(over.map((o) => o.file));
    for (const [file, hits] of Object.entries(files)) {
      if (baseline && !shown.has(file)) continue;
      for (const h of hits) console.log(`${file}:${h.line}:${h.col}  ${h.text}`);
    }
    console.log(`\n[check-theme-colors] ${total} literal(s) in ${Object.keys(files).length} file(s)${baseline ? `, ${over.length} file(s) over the baseline` : ''}.`);
    if (over.length) console.log('Read the color from a token (var(--…)): add it to the module\'s styles/tokens.css, override it in the theme. Data colors: `theme-colors-ignore`. See template CLAUDE.md, « Themes & styles ».');
  }
  if (has('--check') && over.length > 0) process.exit(1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
