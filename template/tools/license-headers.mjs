/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * License header tool. Zero npm dependencies.
 *
 *   node tools/license-headers.mjs --root <dir> --license mit|proprietary [--check]
 *
 * Replaces the known current header variants (block comment or `# ===` shell banner)
 * with the target header, adds one to files lacking any, and never touches another
 * comment. Files whose leading comment looks like a licence notice but matches no known
 * variant are reported as "unclassified" and left untouched. Idempotent. `--check`
 * writes nothing and exits 1 when any file is not already conformant.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const BLOCK_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css']);
const HASH_EXT = new Set(['.sh']);

const MIT_BODY = [
  'VXFramework',
  '',
  'Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>',
  'SPDX-License-Identifier: MIT',
  '',
  'Licensed under the MIT License. See LICENSE in the project root.',
];

const PROPRIETARY_BODY = [
  'VXFramework — Proprietary Software',
  '',
  'Copyright © 2025–2026 Stéphane VAXELAIRE.',
  'All rights reserved.',
  '',
  'This source file is part of VXFramework and is protected by',
  'French Intellectual Property Law (Code de la propriété intellectuelle,',
  'Articles L.111-1 et seq.) and applicable international treaties.',
  '',
  'Use, reproduction, modification, distribution, sublicensing or disclosure',
  'of this file is permitted only under the terms of a valid VXFramework',
  'License Agreement executed with the copyright holder.',
  '',
  'Unauthorized use or distribution is prohibited.',
  '',
  '@author     Stéphane VAXELAIRE',
  '@license    Proprietary — See LICENSE.md',
  '@version    1.0.0',
];

const BANNER = `# ${'='.repeat(77)}`;

/** Build the header text for a licence and a comment style, without trailing newline. */
export function buildHeader(license, style, eol = '\n') {
  const body = license === 'mit' ? MIT_BODY : PROPRIETARY_BODY;
  if (style === 'block') {
    return ['/**', ...body.map((l) => (l ? ` * ${l}` : ' *')), ' */'].join(eol);
  }
  return [BANNER, ...body.map((l) => (l ? `# ${l}` : '#')), BANNER].join(eol);
}

const looksLikeLicence = (s) => /VX\s?Fram|Proprietary|SPDX|Copyright|All rights reserved/i.test(s);

function variantOf(comment, style) {
  if (/SPDX-License-Identifier:\s*MIT/.test(comment)) return `${style}/mit`;
  if (/VX\s?Fram\w*/.test(comment) && /Proprietary\s+Software/.test(comment)) return `${style}/proprietary-software`;
  if (/VX\s?Fram\w*/.test(comment) && /Proprietary\s+Component/.test(comment)) return `${style}/proprietary-component`;
  return null;
}

/**
 * Locate the leading licence-ish comment.
 * Returns { start, end, comment, prefix } where [start,end) is the span to replace
 * (start === end when there is no comment), or { unclassified: true }.
 */
export function locateHeader(text, style) {
  let pos = 0;
  const shebang = text.match(/^#![^\n]*\n/);
  if (shebang) pos = shebang[0].length;
  const blanks = text.slice(pos).match(/^(?:[ \t]*\r?\n)+/);
  const afterBlanks = pos + (blanks ? blanks[0].length : 0);
  // With a shebang keep the original blank separation; without one, drop leading blank lines.
  const start = afterBlanks;
  const rest = text.slice(start);

  let end = -1;
  if (style === 'block') {
    if (rest.startsWith('/*')) {
      const close = rest.indexOf('*/');
      if (close >= 0) end = start + close + 2;
    }
  } else {
    const open = rest.match(/^#[ \t]*={5,}[^\n]*\n/);
    if (open) {
      const m = /^#[ \t]*={5,}[^\n]*$/m.exec(rest.slice(open[0].length));
      if (m) end = start + open[0].length + m.index + m[0].length;
    } else {
      // plain comment lines at the top (e.g. "# VXFramework ...") are not a known variant
      const top = rest.match(/^(?:#[^\n]*\n)+/);
      if (top && looksLikeLicence(top[0])) return { unclassified: true };
    }
  }
  if (end < 0) return { start, end: start, comment: '', shebangEnd: pos, noHeader: true };
  const comment = text.slice(start, end);
  const variant = variantOf(comment, style);
  if (!variant) return looksLikeLicence(comment) ? { unclassified: true } : { start, end: start, comment: '', shebangEnd: pos, noHeader: true };
  return { start, end, comment, variant, shebangEnd: pos };
}

/** Compute the new content for a file. Returns { text, variant, status }. */
export function processText(text, ext, license) {
  const style = HASH_EXT.has(ext) ? 'hash' : 'block';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const target = buildHeader(license, style, eol);
  const loc = locateHeader(text, style);
  if (loc.unclassified) return { text, variant: 'unclassified', status: 'unclassified' };
  if (loc.noHeader) {
    const head = text.slice(0, loc.shebangEnd);
    const tail = text.slice(loc.start);
    const sep = head ? eol : '';
    const next = `${head}${sep}${target}${eol}${tail.startsWith('\n') || tail.startsWith('\r\n') ? '' : eol}${tail}`;
    return { text: next, variant: 'none', status: 'added' };
  }
  if (loc.comment === target) {
    const normalized = loc.shebangEnd ? text : text.slice(loc.start);
    return { text: normalized, variant: loc.variant, status: normalized === text ? 'unchanged' : 'replaced' };
  }
  const prefix = loc.shebangEnd ? text.slice(0, loc.start) : '';
  const next = `${prefix}${target}${text.slice(loc.end)}`;
  return { text: next, variant: loc.variant, status: 'replaced' };
}

function listFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) visit(full);
      else if (isTarget(name)) out.push(full);
    }
  };
  visit(root);
  return out;
}

function isTarget(name) {
  if (name.endsWith('.d.ts')) return false;
  const ext = path.extname(name);
  return BLOCK_EXT.has(ext) || HASH_EXT.has(ext);
}

/** Run over a tree. Returns { counts, changed, unclassified, files }. */
export function run(root, license, { check = false } = {}) {
  const counts = {};
  const changed = [];
  const unclassified = [];
  const files = listFiles(root);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const res = processText(text, path.extname(file), license);
    counts[res.variant] = (counts[res.variant] ?? 0) + 1;
    if (res.status === 'unclassified') unclassified.push(path.relative(root, file));
    else if (res.text !== text) {
      changed.push({ file: path.relative(root, file), status: res.status });
      if (!check) writeFileSync(file, res.text);
    }
  }
  return { counts, changed, unclassified, total: files.length };
}

export function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    if (key === 'check') args.check = true;
    else args[key] = argv[++i];
  }
  if (!args.root || !['mit', 'proprietary'].includes(args.license)) {
    throw new Error('usage: --root <dir> --license mit|proprietary [--check]');
  }
  const res = run(path.resolve(args.root), args.license, { check: !!args.check });
  console.log(`[license-headers] ${res.total} file(s) scanned. Variants detected:`);
  for (const [variant, n] of Object.entries(res.counts).sort()) console.log(`  ${variant}: ${n}`);
  const verb = args.check ? 'would change' : 'changed';
  console.log(`[license-headers] ${verb}: ${res.changed.length}`);
  if (args.check) for (const c of res.changed) console.log(`  ${c.status}: ${c.file}`);
  if (res.unclassified.length) {
    console.log(`[license-headers] unclassified (left untouched): ${res.unclassified.length}`);
    for (const f of res.unclassified) console.log(`  ${f}`);
  }
  return args.check && (res.changed.length || res.unclassified.length) ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`[license-headers] ✖ ${error.message}`);
    process.exitCode = 2;
  }
}
