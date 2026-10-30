/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Small helpers shared by the load-test CLI: argument parsing, .env files, project-local module resolution.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** `--flag`, `--key value`, `--key=value`; a repeated key becomes an array; the rest are positionals. */
export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const next = argv[i + 1];
    const value = eq !== -1 ? arg.slice(eq + 1) : next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    const prev = out.flags[key];
    out.flags[key] = prev === undefined ? value : [].concat(prev, value);
  }
  return out;
}

/** Always an array: `--tier a --tier b` → ['a','b'], `--tier a` → ['a'], absent → []. */
export const listFlag = (value) => (value === undefined || value === true ? [] : [].concat(value));

/** KEY=VALUE lines (`#` comments, optional quotes, optional `export `). */
export function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/** Reads an env file into `env` without overriding variables that are already set; empty values count as unset. Returns the keys it added. */
export function loadEnvFile(file, env = process.env) {
  if (!existsSync(file)) return [];
  const added = [];
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(file, 'utf8')))) {
    if (value !== '' && (env[key] === undefined || env[key] === '')) { env[key] = value; added.push(key); }
  }
  return added;
}

/** Loads an optional dependency from the project's back (`pg`, `ioredis`) — the template itself has no node_modules. */
export function requireFromProject(root, name) {
  for (const stack of ['back', 'front', '.']) {
    const pkg = path.join(root, stack, 'package.json');
    if (!existsSync(pkg)) continue;
    try { return createRequire(pkg)(name); } catch { /* try the next stack */ }
  }
  return null;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export const isLocalHost = (host) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

export function fmt(value, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '–';
}

export const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
