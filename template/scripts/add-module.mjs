#!/usr/bin/env node
/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Add (or remove) shared modules in an existing project. Same engine as create-project.mjs:
 * no code file is modified (wiring goes through the modules' plugins).
 *
 *   node scripts/add-module.mjs <id>...             add modules (+ the closure of their `requires`)
 *   node scripts/add-module.mjs                     interactive: pick from the catalog
 *   node scripts/add-module.mjs --remove <id>...    unlink modules (refused if a linked module needs one)
 *   Options: --root <dir> (default: current directory), --no-install, --yes (defaults, no question),
 *            --answer <questionId>=<value> (repeatable), --dry-run
 *
 * It updates shared-modules.json and project.config.json, regenerates the module blocks of
 * back/.env.example and front/.env.example, appends the new variables to the .env.dev files and
 * the seeded values to back/src/config/defaultConfig.ts, then re-runs link-shared and build-package.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASE_MODULES, appendModuleEnv, applyEnvValues, buildConfigEntries, buildEnvFromAnswers, dependentsOf,
  filterEnvExample, linkedIds, loadCatalog, normalizeAnswers, resolveModules, resolveProject, validateAnswers,
  withQuestionDefaults,
} from './lib/project-engine.mjs';
import { Prompter, askModuleQuestions, csv, selectFunctionalModules } from './lib/wizard.mjs';

const log = {
  info: (m) => console.log(`\x1b[1;34m==>\x1b[0m ${m}`),
  ok: (m) => console.log(`\x1b[1;32m✓\x1b[0m  ${m}`),
  warn: (m) => console.warn(`\x1b[1;33m⚠\x1b[0m  ${m}`),
  err: (m) => console.error(`\x1b[1;31m✖\x1b[0m  ${m}`),
};

export function parseArgs(argv) {
  const opts = { ids: [], answer: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) opts.ids.push(arg);
    else if (['remove', 'no-install', 'yes', 'dry-run'].includes(arg.slice(2))) opts[arg.slice(2)] = true;
    else if (arg === '--answer') opts.answer.push(argv[++i]);
    else if (arg === '--root') opts.root = argv[++i];
    else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Insert missing `defaultConfigEntries` items into the project's defaultConfig.ts. */
export function addConfigEntries(source, entries) {
  const re = /(export const defaultConfigEntries: DefaultConfigEntry\[\] = \[)([\s\S]*?)(\n?\];)/;
  const m = source.match(re);
  if (!m) return { source, added: [] };
  const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const added = entries.filter((e) => !new RegExp(`name:\\s*['"]${e.name}['"]`).test(m[2]));
  if (!added.length) return { source, added };
  const lines = added.map((e) => `  { name: ${q(e.name)}, value: ${q(e.value)}${e.description ? `, description: ${q(e.description)}` : ''} },`);
  const body = m[2].replace(/\s*$/, '');
  return { source: source.replace(re, () => `${m[1]}${body}\n${lines.join('\n')}${m[3].startsWith('\n') ? m[3] : `\n${m[3]}`}`), added };
}

/** Lines `NAME=` / `# NAME=` of `example` whose variable is not declared in `dev`. */
export function missingEnvLines(example, dev) {
  const declared = new Set([...dev.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  const out = [];
  for (const line of example.split('\n')) {
    const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
    if (m && !declared.has(m[1])) {
      declared.add(m[1]);
      out.push(line);
    }
  }
  return out;
}

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
}

function regenerateEnv(root, stack, resolved, catalog, previousIds) {
  const nestStack = stack === 'back' ? 'nest' : 'react';
  const source = path.join(root, stack, '.libs', 'apptemplate', stack, '.env.example');
  if (!existsSync(source)) return null;
  const template = readFileSync(source, 'utf8');
  const render = (ids, perStack) => appendModuleEnv(filterEnvExample(template, ids), catalog, perStack, nestStack);
  const next = render(resolved.ids, resolved.perStack[nestStack]);
  const file = path.join(root, stack, '.env.example');
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const before = resolveModules(catalog, previousIds);
  if (previous === null || previous === render(before.ids, before.perStack[nestStack])) writeFileSync(file, next);
  else {
    writeFileSync(`${file}.new`, next);
    log.warn(`${stack}/.env.example was edited by hand: regenerated version written to ${stack}/.env.example.new`);
  }
  return next;
}

function updateEnvDev(root, stack, example, values) {
  const dev = path.join(root, stack, '.env.dev');
  if (!existsSync(dev) || example === null) return;
  let text = readFileSync(dev, 'utf8');
  const missing = missingEnvLines(example, text);
  if (missing.length) text = `${text.replace(/\n*$/, '\n')}\n# --- added by add-module ---\n${missing.join('\n')}\n`;
  writeFileSync(dev, applyEnvValues(text, values));
}

export async function main(argv) {
  const opts = parseArgs(argv);
  const root = path.resolve(opts.root ?? process.cwd());
  const configFile = path.join(root, 'project.config.json');
  const sharedFile = path.join(root, 'shared-modules.json');
  if (!existsSync(configFile) || !existsSync(sharedFile)) {
    throw new Error(`${root} is not a project created by create-project (project.config.json / shared-modules.json missing)`);
  }
  const answers = normalizeAnswers(readJson(configFile));
  const shared = readJson(sharedFile);
  const pub = path.join(root, 'back', '.libs', 'vx-public');
  const priv = path.join(root, 'back', '.libs', 'vx-private');
  answers.privateAccess = existsSync(priv);
  const catalog = loadCatalog({ public: pub, private: answers.privateAccess ? priv : null });
  const linked = linkedIds(shared);
  const prompter = new Prompter(!opts.yes && opts.ids.length === 0);

  let ids = opts.ids;
  if (!ids.length && !opts.yes) {
    ids = await selectFunctionalModules(prompter, catalog, { ...answers, modules: [] });
    ids = ids.filter((id) => !linked.includes(id));
  }
  prompter.close();
  if (!ids.length) {
    log.warn('No module selected.');
    return 0;
  }

  const nextSelected = opts.remove ? removeSelection(catalog, linked, ids) : [...new Set([...linked, ...ids])];
  const nextAnswers = { ...answers, modules: nextSelected.filter((id) => !BASE_MODULES.includes(id) && id !== 'user'), multiUser: nextSelected.includes('user') };
  const resolved = resolveModules(catalog, nextSelected);
  if (opts.remove) {
    // a closure that re-adds a removed module means another linked module needs it
    const back = ids.filter((id) => resolved.ids.includes(id));
    if (back.length) throw new Error(`cannot remove ${back.join(', ')}: still required by ${back.map((id) => dependentsOf(catalog, id, resolved.ids).join('/')).join(', ')}`);
  } else {
    const full = withQuestionDefaults(catalog, { ...nextAnswers, questions: answers.questions });
    for (const pair of opts.answer) {
      const [id, ...rest] = pair.split('=');
      const raw = rest.join('=');
      full.questions[id] = /^(true|false)$/.test(raw) ? raw === 'true' : raw.includes(',') ? csv(raw) : raw;
    }
    Object.assign(nextAnswers, { questions: full.questions });
  }
  const errors = [...resolved.errors, ...validateAnswers({ ...nextAnswers, projectName: answers.projectName, contactEmail: answers.contactEmail }, catalog)];
  if (errors.length) {
    errors.forEach(log.err);
    return 2;
  }

  const projectResolved = opts.remove ? resolved : resolveProject(catalog, nextAnswers);
  const added = projectResolved.ids.filter((id) => !linked.includes(id));
  const removed = linked.filter((id) => !projectResolved.ids.includes(id));
  log.info(`Back:  ${projectResolved.perStack.nest.join(', ')}\n         Front: ${projectResolved.perStack.react.join(', ')}`);
  if (added.length) log.info(`Linking: ${added.join(', ')}`);
  if (removed.length) log.info(`Unlinking: ${removed.join(', ')}`);
  if (opts['dry-run']) return 0;

  writeFileSync(sharedFile, `${JSON.stringify({ ...shared, nestcommon: projectResolved.perStack.nest, reactcommon: projectResolved.perStack.react }, null, 2)}\n`);
  writeFileSync(configFile, `${JSON.stringify({ ...nextAnswers, resolved: projectResolved.perStack }, null, 2)}\n`);

  const values = buildEnvFromAnswers(catalog, nextAnswers, projectResolved.ids);
  updateEnvDev(root, 'back', regenerateEnv(root, 'back', projectResolved, catalog, linked), values.back);
  updateEnvDev(root, 'front', regenerateEnv(root, 'front', projectResolved, catalog, linked), values.front);

  const defaults = path.join(root, 'back', 'src', 'config', 'defaultConfig.ts');
  if (existsSync(defaults) && !opts.remove) {
    const result = addConfigEntries(readFileSync(defaults, 'utf8'), buildConfigEntries(catalog, nextAnswers, projectResolved.ids));
    if (result.added.length) {
      writeFileSync(defaults, result.source);
      log.ok(`defaultConfig.ts: seeded ${result.added.map((e) => e.name).join(', ')}`);
    }
  }

  for (const stack of ['back', 'front']) {
    const cwd = path.join(root, stack);
    sh('node', ['.libs/apptemplate/scripts/build-package.mjs', stack], cwd);
    sh('node', ['.libs/apptemplate/scripts/link-shared.mjs', stack], cwd);
    if (!opts['no-install'] && existsSync(path.join(cwd, 'node_modules'))) sh('npm', ['install'], cwd);
  }
  log.ok(`${opts.remove ? 'Removed' : 'Added'}: ${(opts.remove ? removed : added).join(', ') || 'nothing to change'}`);
  return 0;
}

/** Selection left after removing `ids` (their dependents stay and re-pull them: caller detects it). */
function removeSelection(catalog, linked, ids) {
  for (const id of ids) {
    if (BASE_MODULES.includes(id)) throw new Error(`"${id}" is a base module and cannot be removed`);
    if (!linked.includes(id)) throw new Error(`"${id}" is not linked in this project`);
  }
  return linked.filter((id) => !ids.includes(id));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { log.err(error.message); process.exitCode = 1; },
  );
}
