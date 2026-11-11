/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { isValidCheckName } from './traceLine';

/** Directories holding one folder per module (`<root>/<module>/validation/checks.json`). */
export const VALIDATION_CHECK_ROOTS = Symbol('VALIDATION_CHECK_ROOTS');

/** What the front may send for one trace name. */
export interface FrontTraceRule {
  /** Accepted on the unauthenticated route (`POST /api/v1/validation/trace/public`). */
  preLogin: boolean;
}

/** Module folders of the running back: `src/modules_shared/*` (links into `.libs/`) and `src/modules/*`. */
export function defaultCheckRoots(cwd: string = process.cwd()): string[] {
  return [path.join(cwd, 'src', 'modules_shared'), path.join(cwd, 'src', 'modules')];
}

const MAX_CHECKS_FILE_BYTES = 512 * 1024;
const RELOAD_AFTER_MS = 30_000;

interface CheckEntry {
  sources?: unknown;
  preLogin?: unknown;
  expect?: { traces?: unknown };
  mustNotHappen?: unknown;
}

function readChecks(file: string): CheckEntry[] {
  try {
    if (fs.statSync(file).size > MAX_CHECKS_FILE_BYTES) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { checks?: unknown };
    return Array.isArray(parsed?.checks) ? (parsed.checks as CheckEntry[]) : [];
  } catch {
    return [];
  }
}

/** Trace names a check declares: its expected traces and the names of its `mustNotHappen` entries (`name[:outcome]`). */
function traceNamesOf(check: CheckEntry): string[] {
  const expected = Array.isArray(check.expect?.traces) ? check.expect.traces : [];
  const forbidden = Array.isArray(check.mustNotHappen) ? check.mustNotHappen.map((entry) => String(entry).split(':')[0]) : [];
  return [...expected, ...forbidden].filter(isValidCheckName);
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

/**
 * Allow-list of the traces the front may send: every trace name of a check whose `sources` includes `front`, in the
 * `validation/checks.json` files of the module folders. Unreadable or malformed files contribute nothing.
 */
export function loadFrontTraceRules(roots: string[]): Map<string, FrontTraceRule> {
  const rules = new Map<string, FrontTraceRule>();
  for (const file of checkFiles(roots)) {
    for (const check of readChecks(file)) {
      if (!Array.isArray(check.sources) || !check.sources.includes('front')) continue;
      for (const name of traceNamesOf(check)) {
        rules.set(name, { preLogin: rules.get(name)?.preLogin === true || check.preLogin === true });
      }
    }
  }
  return rules;
}

/** Runtime registry of the checks declared by the modules (re-read at most every 30 s: a `checks.json` edit needs no restart). */
@Injectable()
export class ValidationCheckRegistry {
  private cache: { at: number; rules: Map<string, FrontTraceRule> } | null = null;

  constructor(@Optional() @Inject(VALIDATION_CHECK_ROOTS) private readonly roots?: string[]) {}

  /** Rule of a trace the front wants to send, or null when no `checks.json` declares it as a front trace. */
  frontRule(trace: string): FrontTraceRule | null {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > RELOAD_AFTER_MS) {
      this.cache = { at: now, rules: loadFrontTraceRules(this.roots ?? defaultCheckRoots()) };
    }
    return this.cache.rules.get(trace) ?? null;
  }
}
