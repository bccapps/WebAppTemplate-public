/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Registry of the validation checks (validation by observation, `nest/common/README.md`): discovery of the
 * `<module>/validation/checks.json` files of the modules a project links (shared-modules.json, resolved like the
 * READMEs by lib-roots.mjs) and of its app modules (`back/src/modules/*`), validation against
 * `nest/common/validation/checks.schema.json` (a dependency-free subset of JSON Schema) and cross-file rules.
 * Zero dependencies, ESM.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { libRoots, readSharedModules, resolveModule } from '../lib-roots.mjs';

/** The schema ships with `common` (one fact, one place); this file sits in `<vx-public>/template/scripts/lib/`. */
export const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../nest/common/validation/checks.schema.json');

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const subdirs = (dir) => (isDir(dir) ? readdirSync(dir).filter((name) => isDir(path.join(dir, name))) : []);

/** `checks.json` of each module folder under `dir` (`<dir>/<module>/validation/checks.json`). */
export function checkFilesUnder(dir, origin) {
  return subdirs(dir)
    .map((module) => ({ module, origin, file: path.join(dir, module, 'validation', 'checks.json') }))
    .filter((entry) => existsSync(entry.file));
}

/**
 * Check files of a project: the back modules listed in shared-modules.json (every module of the library roots when it
 * is unreadable), then the app modules. Front traces are declared in the back module too (`"sources": ["front"]`).
 */
export function discoverCheckFiles(projectRoot) {
  const backDir = path.join(projectRoot, 'back');
  const linked = readSharedModules(projectRoot, 'back');
  const shared = linked
    ? linked.flatMap((name) => {
        const hit = resolveModule('back', backDir, name);
        const file = hit && path.join(hit.dir, 'validation', 'checks.json');
        return file && existsSync(file) ? [{ module: name, origin: hit.origin, file }] : [];
      })
    : libRoots('back', backDir).flatMap((root) => checkFilesUnder(root.dir, root.name));
  return [...shared, ...checkFilesUnder(path.join(backDir, 'src', 'modules'), 'app')];
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  return value === null ? 'null' : typeof value;
}

function resolveRef(root, ref) {
  return ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], root);
}

function validateString(value, schema, at) {
  const errors = [];
  if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  return errors;
}

function validateArray(value, schema, root, at) {
  const errors = [];
  if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
  if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
  if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${at}: duplicate items`);
  if (schema.items) value.forEach((item, i) => errors.push(...validateSchema(item, schema.items, root, `${at}[${i}]`)));
  return errors;
}

function validateObject(value, schema, root, at) {
  const errors = (schema.required ?? []).filter((key) => !(key in value)).map((key) => `${at}: missing "${key}"`);
  for (const [key, item] of Object.entries(value)) {
    const sub = schema.properties?.[key];
    if (sub) errors.push(...validateSchema(item, sub, root, `${at}.${key}`));
    else if (schema.additionalProperties === false) errors.push(`${at}: unknown property "${key}"`);
  }
  return errors;
}

/** Errors of `value` against the JSON Schema subset used by checks.schema.json ($ref, type, enum, string/array/object keywords). */
export function validateSchema(value, schema, root = schema, at = '$') {
  if (schema.$ref) return validateSchema(value, resolveRef(root, schema.$ref), root, at);
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: must be one of ${schema.enum.join(', ')}`];
  const type = typeOf(value);
  if (schema.type && schema.type !== type) return [`${at}: must be ${schema.type}`];
  if (type === 'string') return validateString(value, schema, at);
  if (type === 'array') return validateArray(value, schema, root, at);
  if (type === 'object') return validateObject(value, schema, root, at);
  return [];
}

export function readSchema(file = SCHEMA_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function crossFileErrors(check, entry, seen) {
  const where = `${entry.file} ${check.id}`;
  const errors = [];
  if (check.module !== entry.module) errors.push(`${where}: "module" is "${check.module}", the file belongs to "${entry.module}"`);
  if (seen.has(check.id)) errors.push(`${where}: id already declared in ${seen.get(check.id)}`);
  if (check.preLogin && !(check.sources ?? ['back']).includes('front')) errors.push(`${where}: "preLogin" needs "front" in "sources"`);
  return errors;
}

/**
 * Loads and validates the check files. Returns every valid check (with its `file`), and the errors: invalid JSON,
 * schema violations, a `module` different from the folder, a duplicate id, `preLogin` without a front source.
 */
export function loadRegistry(entries, schema = readSchema()) {
  const checks = [];
  const errors = [];
  const seen = new Map();
  for (const entry of entries) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(entry.file, 'utf8'));
    } catch (error) {
      errors.push(`${entry.file}: invalid JSON (${error.message})`);
      continue;
    }
    const schemaErrors = validateSchema(parsed, schema);
    if (schemaErrors.length) {
      errors.push(...schemaErrors.map((e) => `${entry.file}: ${e}`));
      continue;
    }
    for (const check of parsed.checks) {
      const cross = crossFileErrors(check, entry, seen);
      errors.push(...cross);
      if (cross.length) continue;
      seen.set(check.id, entry.file);
      checks.push({ ...check, sources: check.sources ?? ['back'], file: entry.file, origin: entry.origin });
    }
  }
  return { checks, errors };
}
