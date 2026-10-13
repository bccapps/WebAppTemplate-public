/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Engine shared by create-project.mjs and add-module.mjs. Zero dependencies, no
 * prompt and no I/O except the explicit `load*` / `read*` helpers: everything else is
 * a pure function over plain objects, so it is unit-tested without a project on disk.
 *
 * Vocabulary
 *   catalog   modules of the mounted libraries, read from `<stack>/<module>/module.json`
 *   selected  module ids chosen by the user (+ forced base modules)
 *   resolved  `selected` + transitive closure of `requires`, per stack
 *   answers   the content of project.config.json
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const STACKS = ['nest', 'react'];
/** Always linked, public. `database` only exists on the back. */
export const BASE_MODULES = ['common', 'database'];
/** Wizard database choice -> value of DATABASE_ENGINE (read by nest/database/databases.ts). */
export const DB_ENGINES = { selfhosted: 'postgres', cloud: 'cloud', supabase: 'supabase', neon: 'neon', sqlite: 'sqlite' };
/** Label shown by the wizard for each choice (keys of DB_ENGINES). */
export const DB_ENGINE_LABELS = {
  selfhosted: 'selfhosted (PostgreSQL in a local container)',
  cloud: 'cloud (managed PostgreSQL)',
  supabase: 'supabase (PostgreSQL)',
  neon: 'neon (PostgreSQL)',
  sqlite: 'SQLite (local file, single instance)',
};
/** Database family of a wizard choice, as named by the `databases` field of module.json. */
export const dbFamily = (engine) => (engine === 'sqlite' ? 'sqlite' : 'postgres');
export const REGISTRATION_MODES = { open: 'open', invitation: 'invite-only', waitlist: 'manual' };
export const ANSWERS_SCHEMA_VERSION = 1;

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Read all manifests of one or two library roots.
 * @param {{ public: string, private?: string | null }} roots dirs containing `nest/` and `react/`
 * @returns {Catalog}
 */
export function loadCatalog(roots) {
  const byStack = { nest: new Map(), react: new Map() };
  for (const [origin, root] of [['public', roots.public], ['private', roots.private]]) {
    if (!root) continue;
    for (const stack of STACKS) {
      const stackDir = path.join(root, stack);
      if (!isDir(stackDir)) continue;
      for (const id of readdirSync(stackDir).sort()) {
        const file = path.join(stackDir, id, 'module.json');
        if (!existsSync(file)) continue;
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        if (manifest.id !== id) throw new Error(`${file}: id "${manifest.id}" differs from directory "${id}"`);
        if (byStack[stack].has(id)) throw new Error(`module "${id}" (${stack}) exists in both vx-public and vx-private`);
        byStack[stack].set(id, { ...manifest, origin });
      }
    }
  }
  return buildCatalog(byStack);
}

/** Build the per-id view from per-stack manifests (exported for tests). */
export function buildCatalog(byStack) {
  const byId = new Map();
  for (const stack of STACKS) {
    for (const [id, manifest] of byStack[stack] ?? []) {
      const entry = byId.get(id) ?? {
        id, title: manifest.title, description: manifest.description, category: manifest.category,
        visibility: manifest.visibility, stacks: [], requires: new Set(), env: { nest: [], react: [] }, questions: [],
        databases: null, // null = every engine; otherwise the engine families the module supports (module.json `databases`)
      };
      if (Array.isArray(manifest.databases)) entry.databases = [...new Set([...(entry.databases ?? []), ...manifest.databases])];
      entry.stacks.push(stack);
      for (const r of manifest.requires ?? []) entry.requires.add(r);
      entry.env[stack] = [...(manifest.env ?? [])];
      for (const q of manifest.questions ?? []) {
        if (!entry.questions.some((existing) => existing.id === q.id)) entry.questions.push({ ...q, module: id });
      }
      if (manifest.visibility === 'private') entry.visibility = 'private';
      byId.set(id, entry);
    }
  }
  return { byStack, byId };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Transitive closure of `requires` over the union of both stacks.
 * @returns {{ ids: string[], added: string[], perStack: {nest: string[], react: string[]}, errors: string[] }}
 */
export function resolveModules(catalog, selected) {
  const errors = [];
  const wanted = new Set(selected);
  const ids = new Set();
  const queue = [...wanted];
  while (queue.length) {
    const id = queue.shift();
    if (ids.has(id)) continue;
    const entry = catalog.byId.get(id);
    if (!entry) {
      errors.push(`unknown module "${id}"`);
      continue;
    }
    ids.add(id);
    for (const r of entry.requires) if (!ids.has(r)) queue.push(r);
  }
  const order = (list) => [...BASE_MODULES.filter((b) => list.includes(b)), ...list.filter((m) => !BASE_MODULES.includes(m)).sort()];
  const perStack = {};
  for (const stack of STACKS) {
    perStack[stack] = order([...ids].filter((id) => catalog.byStack[stack].has(id)));
  }
  return { ids: order([...ids]), added: [...ids].filter((id) => !wanted.has(id)).sort(), perStack, errors };
}

/** Reverse dependencies: modules among `linked` (ids) that require `id`. */
export function dependentsOf(catalog, id, linked) {
  return linked.filter((other) => other !== id && catalog.byId.get(other)?.requires.has(id));
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LANG = /^[a-z]{2}(-[A-Z]{2})?$/;

/** Fill defaults and normalize shortcuts (`commerce` -> questions.commerce). Pure. */
export function normalizeAnswers(input = {}) {
  const a = JSON.parse(JSON.stringify(input));
  a.schema = ANSWERS_SCHEMA_VERSION;
  a.ports = { back: 3000, front: 5173, ...(a.ports ?? {}) };
  a.privateAccess = Boolean(a.privateAccess);
  a.multiUser = Boolean(a.multiUser);
  a.modules = [...new Set(a.modules ?? [])];
  a.database = { engine: 'selfhosted', redis: false, ...(a.database ?? {}) };
  a.languages = a.languages?.length ? a.languages : ['fr', 'en'];
  a.questions = { ...(a.questions ?? {}) };
  if (typeof a.commerce === 'boolean') {
    a.questions.commerce = a.commerce;
  }
  delete a.commerce;
  a.env = { ...(a.env ?? {}) };
  delete a.resolved;
  return a;
}

/** Module ids implied by the answers before closure. */
export function selectedModules(answers) {
  const set = new Set(BASE_MODULES);
  for (const m of answers.modules) set.add(m);
  if (answers.multiUser) set.add('user');
  return [...set];
}

/** Questions visible for these answers, in manifest order, with their module resolved. */
export function applicableQuestions(catalog, answers, resolvedIds) {
  const out = [];
  for (const id of resolvedIds) {
    for (const q of catalog.byId.get(id)?.questions ?? []) out.push(q);
  }
  // `alwaysAsk` questions belong to modules that may not be resolved yet (e.g. "sell products?" before `commerce` is linked).
  for (const entry of catalog.byId.values()) {
    if (resolvedIds.includes(entry.id) || !supportsDatabase(entry, answers.database?.engine ?? 'selfhosted')) continue;
    for (const q of entry.questions) {
      if (q.alwaysAsk && (!q.requiresPrivate || answers.privateAccess)) out.push(q);
    }
  }
  return out.filter((q) => conditionHolds(q.when, answers, resolvedIds));
}

/** Evaluate a `when` clause (object or array = all) on answers. */
export function conditionHolds(when, answers, resolvedIds = []) {
  if (!when) return true;
  if (Array.isArray(when)) return when.every((w) => conditionHolds(w, answers, resolvedIds));
  if (when.module !== undefined) return resolvedIds.includes(when.module) === (when.present !== false);
  const value = answers.questions?.[when.question];
  return matches(when, value);
}

/** Compare a value with `equals` / `includes` / `excludes` / `truthy` operators. */
export function matches(op, value) {
  if ('equals' in op) return value === op.equals;
  if ('includes' in op) return Array.isArray(value) ? value.includes(op.includes) : value === op.includes;
  if ('excludes' in op) return Array.isArray(value) ? !value.includes(op.excludes) : value !== op.excludes;
  if ('truthy' in op) return Boolean(value) === Boolean(op.truthy);
  return true;
}

/**
 * Default answer of a question. `defaultMultiUser` overrides `default` when the project has
 * user accounts (e.g. infra: monitoring/cache is on by default for a multi-user app, off otherwise).
 */
export function questionDefault(question, answers = {}) {
  if (answers.multiUser && 'defaultMultiUser' in question) return question.defaultMultiUser;
  if ('default' in question) return question.default;
  if (question.type === 'confirm') return false;
  if (question.type === 'multiselect') return [];
  return question.type === 'select' ? question.options?.[0]?.value : '';
}

function validateQuestionValue(q, value) {
  const values = (q.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
  switch (q.type) {
    case 'confirm':
      return typeof value === 'boolean' ? null : 'expects true or false';
    case 'text':
      return typeof value === 'string' ? null : 'expects a string';
    case 'select':
      return values.includes(value) ? null : `must be one of ${values.join(' | ')}`;
    case 'multiselect':
      if (!Array.isArray(value)) return 'expects a list';
      return value.every((v) => values.includes(v)) ? null : `values must be among ${values.join(' | ')}`;
    default:
      return `unsupported question type "${q.type}"`;
  }
}

/**
 * Cross-check answers against the catalog. Returns human messages; empty = consistent.
 * `catalog` must contain every library the user has access to (and only those).
 */
export function validateAnswers(rawAnswers, catalog) {
  const a = normalizeAnswers(rawAnswers);
  const errors = [];
  if (!KEBAB.test(a.projectName ?? '')) errors.push('projectName must be kebab-case (e.g. my-new-app)');
  if (a.contactEmail && !EMAIL.test(a.contactEmail)) errors.push(`contactEmail "${a.contactEmail}" is not an email address`);
  for (const [k, v] of Object.entries(a.ports)) {
    if (!Number.isInteger(v) || v < 1 || v > 65535) errors.push(`ports.${k} must be an integer between 1 and 65535`);
  }
  if (a.ports.back === a.ports.front) errors.push('ports.back and ports.front must differ');
  if (!(a.database.engine in DB_ENGINES)) errors.push(`database.engine must be one of ${Object.keys(DB_ENGINES).join(' | ')}`);
  for (const l of a.languages) if (!LANG.test(l)) errors.push(`language "${l}" is not a valid language code (fr, en, pt-BR...)`);
  if (a.multiUser && !a.privateAccess) errors.push('multiUser requires privateAccess (the user module lives in vx-private)');

  const resolved = resolveModules(catalog, selectedModules(a));
  errors.push(...resolved.errors);
  errors.push(...databaseIncompatibilities(catalog, resolved.ids, a.database.engine));
  if (!a.privateAccess) {
    for (const id of resolved.ids) {
      if (catalog.byId.get(id)?.visibility === 'private') {
        const why = a.modules.includes(id) ? 'requested' : 'required by another module';
        errors.push(`module "${id}" is private (${why}) but there is no private access`);
      }
    }
  }
  errors.push(...validateQuestionAnswers(a, catalog, resolved.ids));
  return errors;
}

/** True when a catalog entry works with the wizard database choice (`databases` absent = every engine). */
export function supportsDatabase(entry, engine) {
  return !entry?.databases || entry.databases.includes(dbFamily(engine));
}

/**
 * Messages for the modules whose `databases` field excludes the chosen engine
 * (absent field = every engine). Pure; unknown ids are ignored (reported elsewhere).
 */
export function databaseIncompatibilities(catalog, ids, engine) {
  if (!(engine in DB_ENGINES)) return [];
  const family = dbFamily(engine);
  const errors = [];
  for (const id of ids) {
    const entry = catalog.byId.get(id);
    if (!supportsDatabase(entry, engine)) {
      errors.push(`module "${id}" does not support the ${family} database (it supports: ${entry.databases.join(', ')}): choose another database engine or drop this module`);
    }
  }
  return errors;
}

function validateQuestionAnswers(a, catalog, resolvedIds) {
  const errors = [];
  const known = new Map();
  for (const entry of catalog.byId.values()) for (const q of entry.questions) known.set(q.id, q);
  const applicable = new Set(applicableQuestions(catalog, a, resolvedIds).map((q) => q.id));
  for (const [id, value] of Object.entries(a.questions)) {
    const q = known.get(id);
    if (!q) {
      errors.push(`unknown question "${id}"`);
      continue;
    }
    if (!applicable.has(id)) {
      errors.push(`question "${id}" does not apply to this project (module "${q.module}" is not linked or its condition is not met)`);
      continue;
    }
    const problem = validateQuestionValue(q, value);
    if (problem) errors.push(`question "${id}": ${problem}`);
    for (const need of q.requires ?? []) {
      if (value && !resolvedIds.includes(need)) errors.push(`"${id}" needs the "${need}" module: enable multi-user accounts first`);
    }
  }
  return errors;
}

/** Defaults for every applicable question the answers do not cover. */
export function withQuestionDefaults(catalog, rawAnswers) {
  const a = normalizeAnswers(rawAnswers);
  for (let pass = 0; pass < 4; pass++) {
    const resolved = resolveModules(catalog, selectedModules(a));
    let changed = false;
    for (const q of applicableQuestions(catalog, a, resolved.ids)) {
      if (!(q.id in a.questions)) {
        a.questions[q.id] = questionDefault(q, a);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return a;
}

// ---------------------------------------------------------------------------
// Effects: modules, config entries, env
// ---------------------------------------------------------------------------

function effectApplies(effect, value) {
  return !effect.when || matches(effect.when, value);
}

function answerValue(effect, value) {
  if (effect.value === '$answer') {
    return Array.isArray(value) && effect.exclude ? value.filter((v) => !effect.exclude.includes(v)) : value;
  }
  return effect.value;
}

/** Modules added by question effects (e.g. `tenant`, `waitlist`). */
export function effectModules(catalog, answers, resolvedIds) {
  const out = new Set();
  for (const q of applicableQuestions(catalog, answers, resolvedIds)) {
    for (const e of q.effects ?? []) {
      if (e.modules && effectApplies(e, answers.questions[q.id])) e.modules.forEach((m) => out.add(m));
    }
  }
  return [...out];
}

/** Final module resolution including the modules added by question effects. */
export function resolveProject(catalog, rawAnswers) {
  const a = normalizeAnswers(rawAnswers);
  let selected = selectedModules(a);
  let resolved = resolveModules(catalog, selected);
  for (let pass = 0; pass < 4; pass++) {
    const extra = effectModules(catalog, a, resolved.ids).filter((m) => !selected.includes(m));
    if (!extra.length) break;
    selected = [...selected, ...extra];
    resolved = resolveModules(catalog, selected);
  }
  return { selected, ...resolved };
}

const serializeConfigValue = (v) => (typeof v === 'string' ? v : Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : String(v));

/** `defaultConfigEntries` seeded in the new project, from the answers. */
export function buildConfigEntries(catalog, rawAnswers, resolvedIds) {
  const a = normalizeAnswers(rawAnswers);
  const entries = new Map();
  const put = (name, value, description) => entries.set(name, { name, value, description });
  put('localesLanguages', a.languages.join(','), 'Supported languages (create-project)');
  put('localeDefault', a.languages[0], 'Default language (create-project)');
  const json = new Map();
  for (const q of applicableQuestions(catalog, a, resolvedIds)) {
    const value = a.questions[q.id];
    for (const e of q.effects ?? []) {
      if (!effectApplies(e, value)) continue;
      if (e.config) put(e.config.name, serializeConfigValue(answerValue(e.config, value)), `create-project: ${q.id}`);
      if (e.configJson) {
        const doc = json.get(e.configJson.name) ?? {};
        setPath(doc, e.configJson.path, e.configJson.value === '$answer' ? value : e.configJson.value);
        json.set(e.configJson.name, doc);
      }
    }
  }
  for (const [name, doc] of json) put(name, JSON.stringify(doc), 'create-project');
  return [...entries.values()];
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
  cur[keys.at(-1)] = value;
}

/** Env values given by question effects, per stack: `{ back: {...}, front: {...} }`. */
export function buildEnvFromAnswers(catalog, rawAnswers, resolvedIds) {
  const a = normalizeAnswers(rawAnswers);
  const out = { back: {}, front: {} };
  for (const q of applicableQuestions(catalog, a, resolvedIds)) {
    const value = a.questions[q.id];
    for (const e of q.effects ?? []) {
      if (!e.env || !effectApplies(e, value)) continue;
      const v = answerValue(e.env, value);
      if (v !== '' && v !== undefined) out[e.env.stack === 'front' ? 'front' : 'back'][e.env.name] = String(v);
    }
  }
  for (const [name, v] of Object.entries(a.env)) out[name.startsWith('VITE_') ? 'front' : 'back'][name] = String(v);
  return out;
}

/** TypeScript source of `defaultConfigEntries` items. */
export function renderConfigEntries(entries) {
  const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (!entries.length) return '[]';
  const lines = entries.map((e) => `  { name: ${q(e.name)}, value: ${q(e.value)}${e.description ? `, description: ${q(e.description)}` : ''} },`);
  return `[\n${lines.join('\n')}\n]`;
}

/** Patch a copy of the template's defaultConfig.ts. */
export function patchDefaultConfig(source, entries) {
  const re = /export const defaultConfigEntries: DefaultConfigEntry\[\] = \[\];/;
  if (!re.test(source)) throw new Error('defaultConfig.ts: unexpected content (empty defaultConfigEntries not found)');
  return source.replace(re, () => `export const defaultConfigEntries: DefaultConfigEntry[] = ${renderConfigEntries(entries)};`);
}

// ---------------------------------------------------------------------------
// .env.example blocks
// ---------------------------------------------------------------------------

/**
 * Keep the blocks `# @module <ids>` … `# @end` whose condition holds. `<ids>` is a comma
 * list; an id prefixed with `!` means "module NOT linked". The block is active when any
 * item holds. Markers are removed from the output; unmarked text is always kept.
 */
export function filterEnvExample(text, activeModules) {
  const active = new Set(activeModules);
  const out = [];
  let keep = true;
  let inBlock = false;
  for (const line of text.split('\n')) {
    const open = line.match(/^#\s*@module\s+(.+?)\s*$/);
    if (open) {
      if (inBlock) throw new Error('.env.example: nested "# @module" block');
      inBlock = true;
      keep = open[1].split(',').map((s) => s.trim()).some((id) => (id.startsWith('!') ? !active.has(id.slice(1)) : active.has(id)));
      continue;
    }
    if (/^#\s*@end\s*$/.test(line)) {
      if (!inBlock) throw new Error('.env.example: "# @end" without "# @module"');
      inBlock = false;
      keep = true;
      continue;
    }
    if (keep) out.push(line);
  }
  if (inBlock) throw new Error('.env.example: unterminated "# @module" block');
  return out.join('\n');
}

const declaresVar = (text, name) => new RegExp(`^#?\\s*${name}=`, 'm').test(text);

/** Append commented `NAME=` lines for manifest env vars absent from the text (one section per module). */
export function appendModuleEnv(text, catalog, linkedIds, stack) {
  const sections = [];
  for (const id of linkedIds) {
    const entry = catalog.byId.get(id);
    const names = (entry?.env[stack] ?? []).filter((n) => !declaresVar(text, n) && !sections.join('\n').includes(`# ${n}=`));
    if (names.length) sections.push(`# --- ${entry.title} (module ${id}) ---\n${names.map((n) => `# ${n}=`).join('\n')}`);
  }
  if (!sections.length) return text;
  return `${text.replace(/\n*$/, '\n')}\n# =============================================================================\n# Variables declared by the linked modules (module.json)\n# =============================================================================\n${sections.join('\n\n')}\n`;
}

/** Uncomment/overwrite the first `VAR=` line (commented or not), or append it. */
export function applyEnvValues(text, values) {
  let out = text;
  for (const [name, value] of Object.entries(values)) {
    const re = new RegExp(`^#? ?${name}=.*$`, 'm');
    out = re.test(out) ? out.replace(re, () => `${name}=${value}`) : `${out.replace(/\n*$/, '\n')}${name}=${value}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// shared-modules.json
// ---------------------------------------------------------------------------

/** Content of shared-modules.json (keys kept: nestcommon / reactcommon). */
export function buildSharedModules(resolved, doc) {
  return { ...(doc ? { _doc: doc } : {}), nestcommon: resolved.perStack.nest, reactcommon: resolved.perStack.react };
}

/** Linked ids (union of both stacks) from a shared-modules.json object. */
export function linkedIds(sharedModules) {
  return [...new Set([...(sharedModules.nestcommon ?? []), ...(sharedModules.reactcommon ?? [])])];
}
