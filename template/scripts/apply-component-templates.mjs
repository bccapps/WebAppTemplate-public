/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * ONE-SHOT copy of the base UI components / minimal back skeleton listed in
 * `component-templates.json` into a brand-new project, substituting
 * {{SITE_NAME}}, {{ENTITY_NAME}}, {{CONTACT_EMAIL}}, {{PROJECT_NAME}}.
 *
 * Unlike link-config.mjs / link-shared.mjs, this script is NOT meant to be run
 * again after project creation — the copied files become plain, project-owned
 * files from that point on, safe to customize freely. It is invoked ONLY by
 * scripts/create-project.sh.
 *
 * Usage: node scripts/apply-component-templates.mjs <project-root> \
 *          --site-name "..." --entity-name "..." --contact-email "..." --project-name "..."
 *
 * Fails loudly (non-zero exit) if a target file already exists — this script
 * must only ever run once, against a freshly scaffolded project directory.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATE_ROOT = path.resolve(__dirname, '..');
const MANIFEST_FILE = path.join(TEMPLATE_ROOT, 'component-templates.json');

function parseArgs(argv) {
  const [projectRootArg, ...rest] = argv;
  if (!projectRootArg) {
    console.error('[apply-component-templates] ✖ missing <project-root> argument.');
    process.exit(1);
  }
  const opts = { projectRoot: path.resolve(projectRootArg) };
  const flagMap = {
    '--site-name': 'siteName',
    '--entity-name': 'entityName',
    '--contact-email': 'contactEmail',
    '--project-name': 'projectName',
  };
  for (let i = 0; i < rest.length; i += 2) {
    const key = flagMap[rest[i]];
    if (key) opts[key] = rest[i + 1] ?? '';
  }
  return opts;
}

function loadManifest() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  } catch (error) {
    const why = error?.code === 'ENOENT' ? 'introuvable' : `illisible (${error.message})`;
    console.error(`[apply-component-templates] ✖ ${MANIFEST_FILE} ${why} — rien à copier.`);
    process.exit(1);
  }
  const entries = Object.entries(parsed).filter(([key]) => !key.startsWith('_'));
  return Object.fromEntries(entries);
}

function substitute(content, opts) {
  return content
    .replaceAll('{{SITE_NAME}}', opts.siteName ?? '')
    .replaceAll('{{ENTITY_NAME}}', opts.entityName ?? '')
    .replaceAll('{{CONTACT_EMAIL}}', opts.contactEmail ?? '')
    .replaceAll('{{PROJECT_NAME}}', opts.projectName ?? '');
}

async function copyOne(srcRel, tgtRel, opts) {
  const absSrc = path.join(TEMPLATE_ROOT, srcRel);
  const absTgt = path.join(opts.projectRoot, tgtRel);

  if (!existsSync(absSrc)) {
    console.warn(`[apply-component-templates] ⚠ source absente, ignorée: ${srcRel}`);
    return;
  }
  if (existsSync(absTgt)) {
    console.error(`[apply-component-templates] ✖ la cible existe déjà, arrêt: ${tgtRel}`);
    process.exit(1);
  }

  await mkdir(path.dirname(absTgt), { recursive: true });
  const raw = await readFile(absSrc, 'utf8');
  await writeFile(absTgt, substitute(raw, opts), 'utf8');
  console.log(`[apply-component-templates] ✓ ${tgtRel}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();
  const groups = [manifest.front ?? {}, manifest.back ?? {}];
  for (const group of groups) {
    for (const [srcRel, tgtRel] of Object.entries(group)) {
      await copyOne(srcRel, tgtRel, opts);
    }
  }
}

main();
