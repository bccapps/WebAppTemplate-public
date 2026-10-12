/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Materializes the SHARED CONFIG FILES of the AppTemplate into the current
 * project as **relative symlinks**, so a single canonical copy lives in
 * AppTemplate and every project tracks it automatically.
 *
 * This script physically lives in `AppTemplate/scripts/` and is reached from a
 * project via the root `scripts/` symlink. Run it from the PROJECT ROOT:
 *     node scripts/link-config.mjs            # links into $(pwd)
 *     node scripts/link-config.mjs <root>     # links into <root>
 *
 * The mapping (AppTemplate source → project target) lives in
 * `AppTemplate/config-links.json`. Keys starting with "_" are ignored (doc).
 *
 * DOCKER-SAFE TARGETS: symlinks point at the IN-REPO AppTemplate submodule
 * (`<stack>/.libs/apptemplate`), NOT the global AppTemplate dir, so they resolve
 * inside each stack's Docker build context (`COPY . .`), exactly like the
 * nestcommon/reactcommon submodules. The stack (back|front) is the first segment
 * of the target path. The manifest source path is relative to the submodule root
 * (= the app-template repo root, e.g. "back/config/Datasource.ts").
 *
 * SAFETY: real files/directories are NEVER touched. If a project wants its own
 * version of a shared file, it simply keeps a real file at that path — the
 * linker detects it, logs "override conservé", and skips it. Only symlinks the
 * linker itself created are (re)managed. Sources absent (submodule not yet
 * initialized) are skipped with a warning.
 */

import { mkdir, lstat, readlink, rm, symlink } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATE_ROOT = path.resolve(__dirname, '..');
const MANIFEST_FILE = path.join(TEMPLATE_ROOT, 'config-links.json');

const PROJECT_ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.cwd();

// In-repo submodule that holds the canonical files, one checkout per stack so
// each is inside its own Docker build context.
const SUBMODULE_REL = path.join('.libs', 'apptemplate');


/** Load the source→target mapping from config-links.json. Returns {} on error. */
function loadManifest() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  } catch (error) {
    const why = error?.code === 'ENOENT' ? 'introuvable' : `illisible (${error.message})`;
    console.error(`[link-config] ✖ ${MANIFEST_FILE} ${why} — rien à lier.`);
    return {};
  }
  const entries = Object.entries(parsed).filter(([key]) => !key.startsWith('_'));
  return Object.fromEntries(entries);
}

/** Create/refresh one config symlink idempotently. Never clobbers a real file. */
async function linkOne(srcRel, tgtRel) {
  const absTgt = path.join(PROJECT_ROOT, tgtRel);

  // Stack = first path segment of the target (back|front); the canonical file
  // lives in that stack's in-repo submodule checkout → Docker-context-safe.
  const stack = tgtRel.split(path.sep)[0];
  const submoduleRoot = path.join(PROJECT_ROOT, stack, SUBMODULE_REL);
  const absSrc = path.join(submoduleRoot, srcRel);

  if (!existsSync(absSrc)) {
    console.warn(
      `[link-config] ⚠ source absente (submodule ${stack}/${SUBMODULE_REL} non initialisé ?), ignorée: ${srcRel}`,
    );
    return 'skipped';
  }

  await mkdir(path.dirname(absTgt), { recursive: true });
  const target = path.relative(path.dirname(absTgt), absSrc);

  try {
    const stats = await lstat(absTgt);
    if (stats.isSymbolicLink()) {
      if ((await readlink(absTgt)) === target) return 'ok';
      await rm(absTgt, { force: true });
    } else {
      // Real file/dir → project-local override, leave it untouched.
      console.log(`[link-config] • override projet conservé: ${tgtRel}`);
      return 'override';
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await symlink(target, absTgt);
  console.log(`  Linked ${tgtRel} → ${srcRel}`);
  return 'linked';
}

async function main() {
  const manifest = loadManifest();
  const pairs = Object.entries(manifest);
  if (!pairs.length) {
    console.log('[link-config] manifeste vide — rien à lier.');
    return;
  }

  const counts = { linked: 0, ok: 0, override: 0, skipped: 0 };
  for (const [srcRel, tgtRel] of pairs) {
    counts[await linkOne(srcRel, tgtRel)] += 1;
  }

  console.log(
    `[link-config] ${counts.linked} lié(s), ${counts.ok} à jour, ` +
      `${counts.override} override(s) projet, ${counts.skipped} source(s) absente(s) ` +
      `→ ${PROJECT_ROOT}`,
  );
}

await main();
