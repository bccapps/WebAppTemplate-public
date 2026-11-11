/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isValidCheckName } from './traceLine';
import type { TraceFieldRules, TraceFieldType } from './traceSanitizer';

/** What the front may send for one trace name. */
export interface FrontTraceRule {
  /** Accepted on the unauthenticated route (`POST /api/v1/validation/trace/public`). */
  preLogin: boolean;
  /** Fields the front may send (always a declared map: `"*"` is refused for front checks). */
  fields: TraceFieldRules;
}

/** Runtime view of the `validation/checks.json` files: field rules per trace name, per source. */
export interface CheckIndex {
  /** Field rules of every trace name a check declares (back traces). */
  back: Map<string, TraceFieldRules>;
  /** Trace names the front may send: those of checks with `"front"` in `sources`, minus any name a back-only check uses. */
  front: Map<string, FrontTraceRule>;
}

/** Module folders of the running back: `src/modules_shared/*` (links into `.libs/`) and `src/modules/*`. */
export function defaultCheckRoots(cwd: string = process.cwd()): string[] {
  return [path.join(cwd, 'src', 'modules_shared'), path.join(cwd, 'src', 'modules')];
}

const MAX_CHECKS_FILE_BYTES = 512 * 1024;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const ENUM_VALUE = /^[A-Za-z0-9 ._:/-]{1,64}$/;
const SCALAR_TYPES = new Set(['string', 'number', 'boolean', 'id']);

interface CheckEntry {
  sources?: unknown;
  preLogin?: unknown;
  expect?: { traces?: unknown };
  mustNotHappen?: unknown;
  fields?: unknown;
  fieldsJustification?: unknown;
}

function readChecks(file: string): CheckEntry[] {
  try {
    if (fs.statSync(file).size > MAX_CHECKS_FILE_BYTES) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { checks?: unknown };
    return Array.isArray(parsed?.checks) ? (parsed.checks as CheckEntry[]).filter((c) => c && typeof c === 'object') : [];
  } catch {
    return [];
  }
}

function checkFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(root, entry, 'validation', 'checks.json');
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return files;
}

function sourcesOf(check: CheckEntry): string[] {
  return Array.isArray(check.sources) ? check.sources.map(String) : ['back'];
}

/** Trace names a check declares: its expected traces and the names of its `mustNotHappen` entries (`name[:outcome]`). */
export function traceNamesOf(check: CheckEntry): string[] {
  const expected = Array.isArray(check.expect?.traces) ? check.expect.traces : [];
  const forbidden = Array.isArray(check.mustNotHappen) ? check.mustNotHappen.map((entry) => String(entry).split(':')[0]) : [];
  return [...expected, ...forbidden].filter(isValidCheckName);
}

function parseFieldType(type: unknown): TraceFieldType | null {
  if (typeof type === 'string') return SCALAR_TYPES.has(type) ? (type as TraceFieldType) : null;
  if (!Array.isArray(type) || !type.length || type.length > 50) return null;
  return type.every((v) => typeof v === 'string' && ENUM_VALUE.test(v)) ? (type as string[]) : null;
}

/**
 * Field rules of a check: `"*"` only for a back-only check that justifies it (`fieldsJustification`); otherwise the
 * declared map, malformed entries ignored; no `fields` at all = no field allowed.
 */
export function fieldRulesOf(check: CheckEntry): TraceFieldRules {
  const backOnly = sourcesOf(check).every((s) => s === 'back');
  if (check.fields === '*') return backOnly && typeof check.fieldsJustification === 'string' && check.fieldsJustification.trim().length >= 10 ? '*' : {};
  if (!check.fields || typeof check.fields !== 'object' || Array.isArray(check.fields)) return {};
  const rules: Record<string, TraceFieldType> = {};
  for (const [name, type] of Object.entries(check.fields as Record<string, unknown>).slice(0, 24)) {
    const parsed = parseFieldType(type);
    if (FIELD_NAME.test(name) && parsed) rules[name] = parsed;
  }
  return rules;
}

/** Union of two rule sets of one trace name: `"*"` only when both are `"*"`, else the declared maps merged (first wins). */
function mergeRules(a: TraceFieldRules | undefined, b: TraceFieldRules): TraceFieldRules {
  if (a === undefined) return b;
  if (a === '*' && b === '*') return '*';
  if (a === '*') return b;
  if (b === '*') return a;
  return { ...b, ...a };
}

/** Builds the index from the module folders; unreadable or malformed files contribute nothing. */
export function loadCheckIndex(roots: string[]): CheckIndex {
  const checks = checkFiles(roots).flatMap(readChecks);
  const back = new Map<string, TraceFieldRules>();
  const backOnlyNames = new Set<string>();
  for (const check of checks) {
    const rules = fieldRulesOf(check);
    for (const name of traceNamesOf(check)) back.set(name, mergeRules(back.get(name), rules));
    if (!sourcesOf(check).includes('front')) traceNamesOf(check).forEach((name) => backOnlyNames.add(name));
  }
  const front = new Map<string, FrontTraceRule>();
  for (const check of checks.filter((c) => sourcesOf(c).includes('front'))) {
    const rules = fieldRulesOf(check);
    for (const name of traceNamesOf(check).filter((n) => !backOnlyNames.has(n))) {
      const previous = front.get(name);
      const fields = rules === '*' ? {} : mergeRules(previous?.fields, rules);
      front.set(name, { preLogin: previous?.preLogin === true || check.preLogin === true, fields });
    }
  }
  return { back, front };
}

const RELOAD_AFTER_MS = 30_000;
let cache: { at: number; key: string; index: CheckIndex } | null = null;
let configuredRoots: string[] | null = null;

/** Module folders scanned (tests); `null` restores the default (`src/modules_shared`, `src/modules` of the cwd). */
export function setCheckRoots(roots: string[] | null): void {
  configuredRoots = roots;
  cache = null;
}

/** Current index (re-read at most every 30 s: a `checks.json` edit needs no restart). */
export function currentCheckIndex(now: number = Date.now()): CheckIndex {
  const roots = configuredRoots ?? defaultCheckRoots();
  const key = roots.join('\0');
  if (!cache || now - cache.at > RELOAD_AFTER_MS || cache.key !== key) cache = { at: now, key, index: loadCheckIndex(roots) };
  return cache.index;
}
