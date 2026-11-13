/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Test helpers of the secret scanning (gitleaks-config.test.mjs, secret-scan.test.mjs): random values of every registered
// format, built at run time (no secret-shaped literal in a source file, no real value ever), throwaway git sandboxes
// and a gitleaks runner whose report never carries a value (`--redact`, rule / file / line only).

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadSecretFormats } from './secret-formats.mjs';

/** The characters of a registry charset (`A-Za-z0-9_-` → `AB…Zab…z01…9_-`). */
export function charsetAlphabet(registry, charset) {
  return registry.charsets[charset].replace(/(.)-(.)/g, (_, from, to) =>
    Array.from({ length: to.charCodeAt(0) - from.charCodeAt(0) + 1 }, (__, i) => String.fromCharCode(from.charCodeAt(0) + i)).join(''),
  );
}

/** Unbiased random string of `length` characters of `charset`. */
export function randomBody(registry, charset, length) {
  const alphabet = charsetAlphabet(registry, charset);
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) for (const byte of randomBytes(length)) if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
  return out;
}

/** One random value per format (`kind: 'key'`) and per OAuth marker of the OAuth formats (`kind: 'oauth'`), with the rule expected to fire. */
export function formatSamples(registry = loadSecretFormats()) {
  const samples = [];
  for (const format of registry.formats) {
    const length = format.length ?? 32;
    samples.push({ format, kind: 'key', rule: `vx-${format.id}`, value: `${format.prefix}${randomBody(registry, format.charset, length)}` });
    if (!format.oauth) continue;
    for (const marker of registry.oauth.markers) {
      samples.push({ format, kind: 'oauth', rule: `vx-${format.id}-oauth`, value: `${format.prefix}${marker}${randomBody(registry, registry.oauth.charset, registry.oauth.length)}` });
    }
  }
  return samples;
}

/** A deliberately fake value of a format: the marker right after the prefix, the rest random (it passes the entropy filter). */
export function fakeSample(registry, format, marker) {
  const length = format.length ?? 32;
  const charset = format.charset === 'hex' ? 'base64url' : format.charset;
  return `${format.prefix}${marker}${randomBody(registry, charset, length - marker.length)}`;
}

export const gitleaksAvailable = () => !spawnSync('gitleaks', ['version']).error;

/**
 * Runs `gitleaks <args>` with a JSON report; returns `{ status, findings: [{ rule, file, line }] , output }`. The report
 * is redacted and only rule, file and line are kept.
 */
export function gitleaks(args, { cwd, env } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gl-report-'));
  const report = path.join(dir, 'report.json');
  try {
    const r = spawnSync('gitleaks', [...args, '--redact', '--no-banner', '--report-format', 'json', '--report-path', report], { cwd, env, encoding: 'utf8' });
    let findings = [];
    try {
      findings = JSON.parse(readFileSync(report, 'utf8')).map((f) => ({ rule: f.RuleID, file: f.File, line: f.StartLine }));
    } catch {
      findings = [];
    }
    return { status: r.status, findings, output: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A throwaway directory with an isolated git configuration (no user hooks, templates or signing). */
export function sandbox(prefix = 'secret-scan-') {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const home = path.join(base, 'home');
  mkdirSync(home);
  const gitconfig = path.join(home, '.gitconfig');
  writeFileSync(gitconfig, '[user]\n\tname = T\n\temail = t@example.com\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[commit]\n\tgpgsign = false\n');
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C', GIT_TERMINAL_PROMPT: '0' };
  return { base, env, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function git(cwd, env, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Like `git`, without throwing: `{ status, out }` (stdout + stderr). */
export function gitTry(cwd, env, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

export function put(root, rel, content) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}
