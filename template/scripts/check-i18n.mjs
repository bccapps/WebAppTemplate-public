/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * i18n audit — finds translation keys that are referenced in the code but
 * absent from the locale files (they render as raw codes in the UI), and keys
 * that are translated in the base language but missing in another language.
 *
 * Project-agnostic: auto-detects the monorepo root (the dir containing `front/`
 * and/or `back/`) and pools EVERY locale file as the "defined" key space and
 * EVERY source file as the "referenced" key space — because the frontend
 * references keys served from the backend locales and vice-versa.
 *
 * Detection (low false-positive): a referenced key is only considered when it
 * appears in an explicit i18n call site:
 *   - strict  : i18n.get('k') · i18n.translate('k') · getLabel('k') · labelId="k" · i18nKey="k"
 *   - guarded : id="k" · t('k')   (also require the first segment to be a KNOWN
 *               namespace, so plain HTML ids / object paths are never flagged)
 * Only dotted keys (`a.b.c`) are considered. Dynamically-built keys
 * (template literals with `${…}`, concatenations) cannot be verified and are
 * silently ignored — document those via `.i18nrc.json` `ignore` if needed.
 *
 * Usage (from repo root, or from front/ or back/):
 *     node .libs/apptemplate/scripts/check-i18n.mjs            # report, exit 0
 *     node .libs/apptemplate/scripts/check-i18n.mjs --check    # CI: exit 1 if missing refs
 *     node .libs/apptemplate/scripts/check-i18n.mjs --strict   # + fail on language gaps
 *     node .libs/apptemplate/scripts/check-i18n.mjs --unused   # also list defined-but-unused
 *     node .libs/apptemplate/scripts/check-i18n.mjs --base fr  # base language (default en)
 *     node .libs/apptemplate/scripts/check-i18n.mjs --json     # machine-readable output
 *     node .libs/apptemplate/scripts/check-i18n.mjs --root DIR  # force scan root
 *
 * Optional config `.i18nrc.json` at the scan root:
 *   { "baseLang": "en", "ignore": ["^trading\\.dynamic\\."],
 *     "extraSourceDirs": [], "supportedLangs": ["en","fr"] }
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import process from 'process';

/* ── CLI args ─────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
if (has('--help') || has('-h')) {
  console.log(`i18n audit — keys referenced in code but missing from locales, and per-language gaps.

Usage (from repo root, or from front/ or back/):
  node .libs/apptemplate/scripts/check-i18n.mjs           report, exit 0
  node .libs/apptemplate/scripts/check-i18n.mjs --check   CI: exit 1 if missing references
  node .libs/apptemplate/scripts/check-i18n.mjs --strict  also fail on language gaps
  node .libs/apptemplate/scripts/check-i18n.mjs --unused  also list defined-but-unused keys
  node .libs/apptemplate/scripts/check-i18n.mjs --base fr base language (default: en)
  node .libs/apptemplate/scripts/check-i18n.mjs --json    machine-readable output
  node .libs/apptemplate/scripts/check-i18n.mjs --root D  force scan root

Optional .i18nrc.json at the scan root:
  { "baseLang": "en", "ignore": ["^ns\\\\.dynamic\\\\."], "extraSourceDirs": [] }`);
  process.exit(0);
}
const CHECK = has('--check');
const STRICT = has('--strict');
const SHOW_UNUSED = has('--unused');
const JSON_OUT = has('--json');

/* ── Locate scan root (dir holding front/ and/or back/) ───────────── */
function findRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'front')) || existsSync(path.join(dir, 'back'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}
const ROOT = path.resolve(opt('--root', findRoot(process.cwd())));

/* ── Config ───────────────────────────────────────────────────────── */
let cfg = {};
const cfgPath = path.join(ROOT, '.i18nrc.json');
if (existsSync(cfgPath)) {
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); }
  catch (e) { console.error(`[check-i18n] ⚠ .i18nrc.json illisible: ${e.message}`); }
}
const BASE_LANG = opt('--base', cfg.baseLang || 'en');
const IGNORE = (cfg.ignore || []).map((r) => new RegExp(r));
const isIgnored = (k) => IGNORE.some((re) => re.test(k));

/* ── Filesystem walk (skips symlinks, build/vendor dirs) ──────────── */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next', 'out', '.turbo', '.cache']);
function walk(dir, onFile) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      // Symlinked DIRECTORIES are skipped: modules_shared mirrors .libs, and
      // walking both would double-scan (and can loop).
      // Symlinked FILES must still be read — back/src/locales/common.*.json are
      // symlinks into the shared locales checkout. Skipping them made the audit
      // blind to ~500 common keys and report them as missing.
      let target;
      try { target = statSync(full); } catch { continue; } // dangling link
      if (target.isDirectory()) continue;
      if (target.isFile()) onFile(full);
      continue;
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, onFile);
    } else if (e.isFile()) {
      onFile(full);
    }
  }
}

const scanDirs = [];
for (const stack of ['front', 'back']) {
  const d = path.join(ROOT, stack);
  if (existsSync(d)) scanDirs.push(d);
}
for (const extra of cfg.extraSourceDirs || []) {
  const d = path.resolve(ROOT, extra);
  if (existsSync(d)) scanDirs.push(d);
}
if (scanDirs.length === 0) scanDirs.push(ROOT);

/* ── Collect defined keys per language ────────────────────────────── */
const LANG_RE = /(?:^|[.\\/])([a-z]{2})\.json$/;
const perLang = {};          // lang -> Set(key)
const keyToFiles = {};       // key -> Set(localeFile) (base lang only, for hints)
const localeFiles = [];

function flatten(obj, prefix, out) {
  // Locale files are flat dotted maps in this codebase, but support nested too.
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.add(key);
  }
}

for (const root of scanDirs) {
  walk(root, (file) => {
    if (!file.endsWith('.json') || !/[\\/]locales[\\/]/.test(file)) return;
    const m = file.match(LANG_RE);
    if (!m) return;
    const lang = m[1];
    let data;
    try { data = JSON.parse(readFileSync(file, 'utf8')); }
    catch { return; }
    if (!data || typeof data !== 'object') return;
    const keys = new Set();
    flatten(data, '', keys);
    (perLang[lang] ??= new Set());
    for (const k of keys) {
      perLang[lang].add(k);
      if (lang === BASE_LANG) (keyToFiles[k] ??= new Set()).add(path.relative(ROOT, file));
    }
    localeFiles.push(path.relative(ROOT, file));
  });
}

const langs = Object.keys(perLang).sort();
if (!perLang[BASE_LANG]) {
  console.error(`[check-i18n] ✖ Aucune locale pour la langue de base '${BASE_LANG}'. Langues trouvées: ${langs.join(', ') || 'aucune'}.`);
  process.exit(2);
}
const definedBase = perLang[BASE_LANG];
const allDefined = new Set();
for (const s of Object.values(perLang)) for (const k of s) allDefined.add(k);
const knownNamespaces = new Set([...allDefined].map((k) => k.split('.')[0]));

/* ── Collect referenced keys from source ──────────────────────────── */
const KEY_SHAPE = /^[A-Za-z][\w]*(?:\.[\w-]+)+$/; // dotted, ≥2 segments
// strict: unambiguous i18n call sites → any dotted key
const STRICT_RE = /(?:i18n\.(?:get|getForLang|translate)|getLabel|labelId\s*=\s*|i18nKey\s*=\s*)(?:\?\.)?\(?\s*["'`]([\w.\-]+)["'`]/g;
// guarded: generic patterns → require a known namespace to avoid false positives
const GUARDED_RE = /(?:\bid\s*[:=]\s*|[^.\w]t\()\s*["'`]([\w.\-]+)["'`]/g;
const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte']);
const refs = new Map(); // key -> Set(file)

function addRef(key, file) {
  if (!KEY_SHAPE.test(key) || isIgnored(key)) return;
  let set = refs.get(key);
  if (!set) { set = new Set(); refs.set(key, set); }
  set.add(path.relative(ROOT, file));
}

for (const root of scanDirs) {
  walk(root, (file) => {
    const ext = path.extname(file);
    if (!SRC_EXT.has(ext)) return;
    if (/[\\/]locales[\\/]/.test(file) || /\.(spec|test|d)\.[tj]sx?$/.test(file)) return;
    let s;
    try { s = readFileSync(file, 'utf8'); } catch { return; }
    if (!s.includes('.')) return;
    let m;
    STRICT_RE.lastIndex = 0;
    while ((m = STRICT_RE.exec(s))) addRef(m[1], file);
    GUARDED_RE.lastIndex = 0;
    while ((m = GUARDED_RE.exec(s))) {
      const key = m[1];
      if (knownNamespaces.has(key.split('.')[0])) addRef(key, file);
    }
  });
}

/* ── Diff ─────────────────────────────────────────────────────────── */
const missing = [...refs.keys()].filter((k) => !definedBase.has(k)).sort();
const langGaps = {}; // lang -> [keys in base but not in lang]
for (const lang of langs) {
  if (lang === BASE_LANG) continue;
  langGaps[lang] = [...definedBase].filter((k) => !perLang[lang].has(k)).sort();
}
const referencedSet = new Set(refs.keys());
const unused = SHOW_UNUSED
  ? [...definedBase].filter((k) => !referencedSet.has(k) && !isIgnored(k)).sort()
  : [];

/* ── Output ───────────────────────────────────────────────────────── */
const totalGaps = Object.values(langGaps).reduce((a, b) => a + b.length, 0);

if (JSON_OUT) {
  console.log(JSON.stringify({
    root: ROOT, baseLang: BASE_LANG, langs,
    definedBaseCount: definedBase.size, referencedCount: refs.size,
    missing, langGaps, unused,
  }, null, 2));
} else {
  console.log(`\n[check-i18n] root=${ROOT}`);
  console.log(`[check-i18n] langs=[${langs.join(', ')}] base=${BASE_LANG} · defined(base)=${definedBase.size} · referenced=${refs.size} · localeFiles=${localeFiles.length}\n`);

  if (missing.length) {
    console.log(`✖ ${missing.length} key(s) REFERENCED but MISSING in '${BASE_LANG}' (rendered as raw code):`);
    for (const k of missing) {
      const files = [...(refs.get(k) || [])].slice(0, 3).join(', ');
      console.log(`   • ${k}   ← ${files}${refs.get(k)?.size > 3 ? ', …' : ''}`);
    }
    console.log('');
  } else {
    console.log(`✓ No missing references in '${BASE_LANG}'.\n`);
  }

  for (const lang of Object.keys(langGaps)) {
    const gaps = langGaps[lang];
    if (!gaps.length) { console.log(`✓ '${lang}' is complete vs '${BASE_LANG}'.`); continue; }
    console.log(`⚠ ${gaps.length} key(s) in '${BASE_LANG}' MISSING in '${lang}':`);
    for (const k of gaps.slice(0, 50)) console.log(`   • ${k}`);
    if (gaps.length > 50) console.log(`   … and ${gaps.length - 50} more`);
  }
  console.log('');

  if (SHOW_UNUSED) {
    console.log(unused.length
      ? `ℹ ${unused.length} defined key(s) never referenced (may be dynamic — review before deleting):`
      : `✓ No obviously-unused keys.`);
    for (const k of unused.slice(0, 50)) console.log(`   • ${k}`);
    if (unused.length > 50) console.log(`   … and ${unused.length - 50} more`);
    console.log('');
  }
}

/* ── Exit code ────────────────────────────────────────────────────── */
let exit = 0;
if (CHECK && missing.length) exit = 1;
if (STRICT && totalGaps) exit = 1;
if (!JSON_OUT && (CHECK || STRICT)) {
  console.log(exit ? `[check-i18n] FAILED (missing=${missing.length}, langGaps=${totalGaps}).` : `[check-i18n] OK.`);
}
process.exit(exit);
