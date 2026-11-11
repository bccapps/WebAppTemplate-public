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
  const keys = Object.keys(value);
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${at}: more than ${schema.maxProperties} properties`);
  for (const key of keys) {
    if (schema.propertyNames) errors.push(...validateSchema(key, schema.propertyNames, root, `${at} key "${key}"`));
    const sub = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
    if (sub) errors.push(...validateSchema(value[key], sub, root, `${at}.${key}`));
    else if (schema.additionalProperties === false) errors.push(`${at}: unknown property "${key}"`);
  }
  return errors;
}

/** Errors of `value` against the JSON Schema subset used by checks.schema.json ($ref, type, enum, string/array/object keywords). */
export function validateSchema(value, schema, root = schema, at = '$') {
  if (schema.$ref) return validateSchema(value, resolveRef(root, schema.$ref), root, at);
  if (schema.anyOf) {
    const failures = schema.anyOf.map((option) => validateSchema(value, option, root, at));
    return failures.some((f) => f.length === 0) ? [] : [`${at}: matches none of the allowed forms (${failures.map((f) => f[0]).join(' | ')})`];
  }
  if ('const' in schema && value !== schema.const) return [`${at}: must be ${JSON.stringify(schema.const)}`];
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

const traceNamesOf = (check) => [...check.expect.traces, ...(check.mustNotHappen ?? []).map((spec) => spec.split(':')[0])];

function crossFileErrors(check, entry, seen) {
  const where = `${entry.file} ${check.id}`;
  const sources = check.sources ?? ['back'];
  const errors = [];
  if (check.module !== entry.module) errors.push(`${where}: "module" is "${check.module}", the file belongs to "${entry.module}"`);
  if (seen.has(check.id)) errors.push(`${where}: id already declared in ${seen.get(check.id)}`);
  if (check.preLogin && !sources.includes('front')) errors.push(`${where}: "preLogin" needs "front" in "sources"`);
  if (check.preLogin && ['critical', 'high'].includes(check.severity)) errors.push(`${where}: "preLogin" is refused for a ${check.severity} check (anyone could send its traces)`);
  if (check.fields === '*' && sources.includes('front')) errors.push(`${where}: "fields": "*" is refused for a check with a front source (declare each field)`);
  if (check.fields === '*' && !check.fieldsJustification) errors.push(`${where}: "fields": "*" needs a "fieldsJustification"`);
  return errors;
}

/**
 * Rules across checks, per trace name: a name a front check sends may not be used by a back-only check (the front could
 * otherwise fake its evidence), and two checks may not give one field of a trace two different types.
 */
function traceNameErrors(checks) {
  const byName = new Map();
  for (const check of checks) for (const name of traceNamesOf(check)) byName.set(name, [...(byName.get(name) ?? []), check]);
  const errors = [];
  for (const [name, users] of byName) {
    const front = users.filter((c) => c.sources.includes('front'));
    const backOnly = users.filter((c) => !c.sources.includes('front'));
    if (front.length && backOnly.length) {
      errors.push(`trace "${name}": sent by the front (${front.map((c) => c.id).join(', ')}) and used by back-only ${backOnly.map((c) => c.id).join(', ')}: use distinct names`);
    }
    const types = new Map();
    for (const check of users.filter((c) => c.fields && c.fields !== '*')) {
      for (const [field, type] of Object.entries(check.fields)) {
        const seen = types.get(field);
        if (seen && JSON.stringify(seen.type) !== JSON.stringify(type)) errors.push(`trace "${name}": field "${field}" typed differently by ${seen.id} and ${check.id}`);
        if (!seen) types.set(field, { type, id: check.id });
      }
    }
  }
  return errors;
}

/**
 * Loads and validates the check files. Returns every valid check (with its `file`), and the errors: invalid JSON,
 * schema violations, a `module` different from the folder, a duplicate id, `preLogin` without a front source, `"*"`
 * fields on a front check or without justification, a trace name shared by a front check and a back-only check, a
 * field typed differently by two checks of one trace.
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
  return { checks, errors: [...errors, ...traceNameErrors(checks)] };
}
