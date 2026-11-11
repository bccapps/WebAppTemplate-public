/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Reading of validation logs (validation by observation, `nest/common/README.md`): log files of a directory or of a
 * tar archive, the JSONL trace lines, the evaluation of the registry checks and the permanent secret-leak scan of
 * every log file. A secret found is NEVER shown: only file:line, its type, a `sha256:<8 hex>` fingerprint and its
 * length. Zero dependencies, ESM.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const VALIDATION_FILE = /^validation-\d{4}-\d{2}-\d{2}\.jsonl$/;
const ARCHIVE = /\.(tar\.gz|tgz|tar)$/i;
const MAX_DEPTH = 3;

const DURATION = /^(\d{1,4})(m|h|d)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `--since`: a duration back from `now` (`30m`, `24h`, `7d`) or a date (`2026-11-01`, ISO); epoch ms, or null if invalid. */
export function parseSince(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  const duration = DURATION.exec(text);
  if (duration) return now - Number(duration[1]) * UNIT_MS[duration[2]];
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : at;
}

export function fingerprint(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

/** Regular files under `dir` (symbolic links skipped, depth ≤ 3), sorted. */
export function listLogFiles(dir, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.sort().flatMap((name) => {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      return [];
    }
    if (stat.isDirectory()) return listLogFiles(file, depth + 1);
    return stat.isFile() && !/\.(gz|zip|tgz|tar)$/i.test(name) ? [file] : [];
  });
}

/** Plain relative member names only: no absolute path, no `..`, no segment starting with `-` (never read as a tar option), no glob character. */
const SAFE_MEMBER = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;

/** Archive members that are validation files with a safe relative name. */
export function safeArchiveMembers(listing) {
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => SAFE_MEMBER.test(name) && !name.split('/').some((seg) => seg === '..' || seg.startsWith('-')))
    .filter((name) => VALIDATION_FILE.test(path.basename(name)));
}

/**
 * The directory to read: `source` itself, or a private temporary copy of the validation files of a tar archive
 * (members listed and filtered first; `cleanup` removes the copy).
 */
export function openLogSource(source) {
  if (!ARCHIVE.test(source)) return { dir: source, cleanup: () => undefined };
  const members = safeArchiveMembers(execFileSync('tar', ['-tf', source], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const dir = mkdtempSync(path.join(tmpdir(), 'validation-logs-'));
  if (members.length) execFileSync('tar', ['-xf', source, '-C', dir, '--', ...members], { stdio: 'ignore' });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function* readLines(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let number = 0;
  for await (const line of rl) {
    number += 1;
    yield { line, number };
  }
}

function keepLine(entry, { since, env }) {
  if (since && !(Date.parse(entry.ts) >= since)) return false;
  return !env || entry.env === env;
}

/** Parsed trace lines of the `validation-*.jsonl` files, filtered by time (`since`, ms) and `env`, with read statistics. */
export async function readTraceLines(files, filter = {}) {
  const lines = [];
  const stats = { files: 0, lines: 0, invalid: 0, capped: [] };
  for (const file of files.filter((f) => VALIDATION_FILE.test(path.basename(f)))) {
    stats.files += 1;
    for await (const { line, number } of readLines(file)) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        stats.invalid += 1;
        continue;
      }
      if (typeof entry?.check !== 'string' || !keepLine(entry, filter)) continue;
      stats.lines += 1;
      if (entry.check === 'validation.trace.capped') stats.capped.push(path.basename(file));
      lines.push({ entry, raw: line, file, number });
    }
  }
  return { lines, stats };
}

/**
 * Leak detectors. `high` fails the report; the shapes that also occur in harmless application logs (hashes, e-mails)
 * are `high` only in validation files, where the sanitizer must have removed them.
 */
const NOT_A_VALUE = /^(\[redacted|\*{3}|sha256:|<redacted>|redacted$|undefined$|null$|true$|false$)/i;
export const LEAK_PATTERNS = [
  { type: 'jwt', regex: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, severity: () => 'high' },
  { type: 'bearer', regex: /\bbearer\s+([A-Za-z0-9._~+/=-]{16,})/gi, group: 1, severity: () => 'high' },
  {
    type: 'prefixed-token',
    regex: /(?<![A-Za-z0-9])(?:(?:tk|ctd|mst|ac_live|ac_test|sup|acs|ahe|ahf|ahi|ahr|sk_live|sk_test|rk_live|whsec|ghp|gho|ghs|ghu|github_pat)_|sk-|glpat-|xox[bp]-|xkeysib-)([A-Za-z0-9_-]{12,})/g,
    accept: (match) => /[0-9A-Z]/.test(match[1]),
    severity: () => 'high',
  },
  { type: 'aws-key', regex: /\bAKIA[0-9A-Z]{16}\b/g, severity: () => 'high' },
  { type: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, severity: () => 'high' },
  { type: 'url-credentials', regex: /[a-z][a-z0-9+.-]*:\/\/[^\s:@/"']+:([^\s@/"']+)@/gi, group: 1, accept: (m) => !NOT_A_VALUE.test(m[1]), severity: () => 'high' },
  {
    type: 'credential-assignment',
    regex: /(?:password|passwd|pwd|pphrase|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?([^\s"',;&}]{4,})/gi,
    group: 1,
    accept: (match) => !NOT_A_VALUE.test(match[1]),
    severity: () => 'high',
  },
  {
    type: 'email',
    regex: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g,
    accept: (match) => !/^(noreply|no-reply|postmaster)$/i.test(match[1]) && !/^example\.(com|org|net|fr)$/i.test(match[2]),
    severity: (inValidation) => (inValidation ? 'high' : 'medium'),
  },
  { type: 'hex-secret', regex: /(?<![A-Za-z0-9])(?:0x)?[0-9a-fA-F]{64}(?![A-Za-z0-9])/g, severity: (v) => (v ? 'high' : 'low') },
  {
    type: 'base64-blob',
    regex: /[A-Za-z0-9+/_-]{40,}={0,2}/g,
    accept: (match) => /[0-9]/.test(match[0]) && /[A-Z]/.test(match[0]) && /[a-z]/.test(match[0]),
    severity: (v) => (v ? 'high' : 'low'),
  },
];

/** Secret-looking values of one line: type, severity, fingerprint and length (never the value). */
export function findLeaks(text, inValidation) {
  const found = [];
  for (const pattern of LEAK_PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      if (pattern.accept && !pattern.accept(match)) continue;
      const value = match[pattern.group ?? 0];
      found.push({ type: pattern.type, severity: pattern.severity(inValidation), fingerprint: fingerprint(value), length: value.length });
    }
  }
  return found;
}

/** Same line with every secret-looking value replaced by `[<type> sha256:<8 hex>]` (for the samples shown). */
export function scrubForDisplay(text) {
  let out = text;
  for (const pattern of LEAK_PATTERNS) {
    out = out.replace(pattern.regex, (...args) => {
      const match = args.slice(0, -2);
      if (pattern.accept && !pattern.accept(match)) return match[0];
      return `[${pattern.type} ${fingerprint(match[0])}]`;
    });
  }
  return out;
}

/** Leak scan of every log file (validation or not). `relativeTo` shortens the file names shown. */
export async function scanLeaks(files, relativeTo) {
  const findings = [];
  for (const file of files) {
    const inValidation = VALIDATION_FILE.test(path.basename(file));
    for await (const { line, number } of readLines(file)) {
      for (const leak of findLeaks(line, inValidation)) findings.push({ file: path.relative(relativeTo, file), line: number, ...leak });
    }
  }
  return findings;
}
