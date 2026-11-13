#!/usr/bin/env node
/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Generates the gitleaks configuration of a project (`.gitleaks.toml`) from the single registry of secret formats
// (`nest/common/validation/secret-formats.json` of vx-public): the default gitleaks rules, one exact rule per VX format
// (prefix, alphabet, length, entropy), one per family of mcp-access OAuth tokens, an allowlist BY VALUE for deliberately
// fake secrets (`<prefix>FAKE…`), then the project's own rules and allowlists, copied verbatim from `.gitleaks.local.toml`.
// Run by scripts/update_common.sh; a hand-written `.gitleaks.toml` is never overwritten (exit 3 and how to migrate it).
//
//   node scripts/gitleaks-config.mjs [<project root>]           write <root>/.gitleaks.toml (default: the current directory)
//   node scripts/gitleaks-config.mjs --check [<project root>]   exit 1 when it differs from what would be generated
//   node scripts/gitleaks-config.mjs --stdout                   print the generated rules (no project fragment)

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeRegExp, loadSecretFormats } from './lib/secret-formats.mjs';

export const CONFIG_FILE = '.gitleaks.toml';
export const LOCAL_FILE = '.gitleaks.local.toml';
/** Line that marks a generated file (the only kind this script rewrites). */
export const GENERATED_MARKER = '# vx-generated: gitleaks-config.mjs';
export const RULE_ID_PREFIX = 'vx-';
/** Exit status when a hand-written .gitleaks.toml is kept. */
export const EXIT_KEPT = 3;

const tomlString = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const tomlArray = (values) => `[${values.map(tomlString).join(', ')}]`;
const tomlRegex = (value) => {
  if (value.includes("'''")) throw new Error(`regex not representable as a TOML literal string: ${value}`);
  return `'''${value}'''`;
};

function quantifier(format) {
  return format.length !== undefined ? `{${format.length}}` : `{${format.minLength},${format.maxLength}}`;
}

/**
 * Rule of one format. No left boundary (a key glued to `\n` in an escaped JSON string, or after `MY_`, is still found);
 * an exact length ends on a non-alphabet character, which keeps a key and the longer OAuth tokens of the same prefix
 * apart. Percent-encoded forms (`tk%5F…`, `Bearer%20tk_…`) are decoded by gitleaks itself (8.30: `--max-decode-depth`).
 */
export function ruleOf(format, registry) {
  const cls = registry.charsets[format.charset];
  const body = `${escapeRegExp(format.prefix)}[${cls}]${quantifier(format)}`;
  const regex = format.length !== undefined ? `(${body})(?:[^${cls}]|$)` : `(${body})`;
  return { id: `${RULE_ID_PREFIX}${format.id}`, description: `${format.description} — ${format.source}`, regex, entropy: format.minEntropy, keywords: [format.prefix] };
}

/** Rule of the mcp-access OAuth tokens of one prefix (`<prefix>at_|rt_|cs_` + 43 base64url). */
export function oauthRuleOf(format, registry) {
  const { markers, charset, length, minEntropy, description, source } = registry.oauth;
  const cls = registry.charsets[charset];
  const alternatives = markers.map(escapeRegExp).join('|');
  return {
    id: `${RULE_ID_PREFIX}${format.id}-oauth`,
    description: `${format.app}: ${description} — ${source}`,
    regex: `(${escapeRegExp(format.prefix)}(?:${alternatives})[${cls}]{${length}})(?:[^${cls}]|$)`,
    entropy: minEntropy,
    keywords: markers.map((marker) => `${format.prefix}${marker}`),
  };
}

export function rulesOf(registry) {
  return registry.formats.flatMap((format) => (format.oauth ? [ruleOf(format, registry), oauthRuleOf(format, registry)] : [ruleOf(format, registry)]));
}

/** `^(?:<every prefix>)(?:(?:at_|rt_|cs_))?(?:FAKE|EXAMPLE)`: a fake value is recognised by its marker, by value. */
export function fakeValueRegex(registry) {
  const prefixes = [...new Set(registry.formats.map((format) => format.prefix))].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const markers = registry.oauth.markers.map(escapeRegExp).join('|');
  return `^(?:${prefixes})(?:${markers})?(?:${registry.fakeMarkers.map(escapeRegExp).join('|')})`;
}

function renderRule(rule) {
  const lines = ['[[rules]]', `id = ${tomlString(rule.id)}`, `description = ${tomlString(rule.description)}`, `regex = ${tomlRegex(rule.regex)}`, 'secretGroup = 1'];
  if (rule.entropy > 0) lines.push(`entropy = ${rule.entropy.toFixed(1)}`);
  lines.push(`keywords = ${tomlArray(rule.keywords)}`);
  return lines.join('\n');
}

/** Problems of a project fragment (it is appended verbatim: it must not redefine what the generated part owns). */
export function checkLocalFragment(text) {
  const problems = [];
  const lines = String(text).split(/\r?\n/);
  if (lines.some((line) => /^\s*title\s*=/.test(line))) problems.push('defines "title" (owned by the generated part)');
  if (lines.some((line) => /^\s*\[extend\]/.test(line) || /^\s*useDefault\s*=/.test(line))) problems.push('defines [extend] (the generated part already extends the default rules)');
  if (lines.some((line) => /^\s*\[allowlist\]/.test(line))) problems.push('uses the old [allowlist] table: write [[allowlists]] (gitleaks refuses both in one file)');
  for (const line of lines) {
    const id = /^\s*id\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
    if (id?.startsWith(RULE_ID_PREFIX)) problems.push(`rule id "${id}" starts with "${RULE_ID_PREFIX}" (reserved for the generated rules)`);
  }
  return problems;
}

/** The whole `.gitleaks.toml`: header, default rules, VX rules, fake-value allowlist, then the project fragment if any. */
export function renderGitleaksConfig(registry, local = null) {
  const parts = [
    `${GENERATED_MARKER} — do not edit.`,
    '# Generated by scripts/gitleaks-config.mjs (vx-public template) from nest/common/validation/secret-formats.json, rewritten by',
    '# scripts/update_common.sh. The project\'s own rules and allowlists go in .gitleaks.local.toml (copied at the end of this file).',
    '# Template README, « Secret scanning ».',
    '',
    'title = "VX gitleaks configuration"',
    '',
    '[extend]',
    'useDefault = true',
    '',
    ...rulesOf(registry).map((rule) => `${renderRule(rule)}\n`),
    '[[allowlists]]',
    `description = ${tomlString(`Deliberately fake VX secrets: ${registry.fakeMarkers.join(' or ')} right after the prefix (and the OAuth marker), by value, never by path`)}`,
    'regexTarget = "secret"',
    `regexes = [${tomlRegex(fakeValueRegex(registry))}]`,
  ];
  if (local !== null && local.trim()) parts.push('', `# ---- ${LOCAL_FILE} (project rules, verbatim) ----`, local.replace(/\s+$/, ''));
  return `${parts.join('\n')}\n`;
}

/**
 * Writes `<root>/.gitleaks.toml` unless a hand-written one is there. Returns
 * `{ status: 'written' | 'unchanged' | 'kept' | 'invalid-local', file, problems? }`.
 */
export function writeGitleaksConfig(root, { registry = loadSecretFormats(), check = false } = {}) {
  const file = path.join(root, CONFIG_FILE);
  const localFile = path.join(root, LOCAL_FILE);
  const local = existsSync(localFile) ? readFileSync(localFile, 'utf8') : null;
  const problems = local === null ? [] : checkLocalFragment(local);
  if (problems.length) return { status: 'invalid-local', file: localFile, problems };
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (current !== null && !current.includes(GENERATED_MARKER)) return { status: 'kept', file };
  const next = renderGitleaksConfig(registry, local);
  if (current === next) return { status: 'unchanged', file };
  if (check) return { status: 'outdated', file };
  writeFileSync(file, next);
  return { status: 'written', file };
}

const MESSAGES = {
  written: (r) => `gitleaks: ${r.file} generated`,
  unchanged: (r) => `gitleaks: ${r.file} up to date`,
  outdated: (r) => `gitleaks: ${r.file} is not the generated one: run node scripts/gitleaks-config.mjs`,
  kept: (r) =>
    `gitleaks: ${r.file} is hand-written, kept as is. To use the template rules: move the project's own rules and allowlists (not the app key ` +
    `rules, now generated from secret-formats.json) to ${LOCAL_FILE}, delete ${CONFIG_FILE}, then re-run scripts/update_common.sh`,
  'invalid-local': (r) => `gitleaks: ${r.file}: ${r.problems.join('; ')}`,
};

function main(argv) {
  const check = argv.includes('--check');
  if (argv.includes('--stdout')) {
    process.stdout.write(renderGitleaksConfig(loadSecretFormats()));
    return 0;
  }
  const unknown = argv.filter((arg) => arg.startsWith('-') && arg !== '--check');
  if (unknown.length) {
    console.error(`unknown option: ${unknown.join(' ')}`);
    return 2;
  }
  const root = path.resolve(argv.find((arg) => !arg.startsWith('-')) ?? process.cwd());
  const result = writeGitleaksConfig(root, { check });
  const message = MESSAGES[result.status](result);
  if (result.status === 'written' || result.status === 'unchanged') console.log(message);
  else console.error(message);
  if (result.status === 'kept') return EXIT_KEPT;
  return ['written', 'unchanged'].includes(result.status) ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
