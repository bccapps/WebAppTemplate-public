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
 * tar archive, the JSONL trace lines, and the permanent secret-leak scan of every log file. A secret found is NEVER
 * shown: only file:line, its type, its length and — for values of 12 characters or more — a keyed fingerprint
 * (`hmac:<16 hex>`, key kept in `.validation-cache/`, 0600). Every pattern is anchored or bounded (linear time) and
 * long lines are scanned in overlapping chunks. Zero dependencies, ESM.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ARCHIVE_PATTERN, extractValidationFiles } from './validation-archive.mjs';

export const VALIDATION_FILE = /^validation-\d{4}-\d{2}-\d{2}\.jsonl$/;
const MAX_DEPTH = 3;
/** Lines longer than this are scanned in chunks (with an overlap longer than any secret shape searched). */
const CHUNK = 16 * 1024;
const OVERLAP = 512;
/** Below this length a value is not fingerprinted (a short value is guessed from its fingerprint): type + length only. */
export const MIN_FINGERPRINT_LENGTH = 12;

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

let fingerprintKey = randomBytes(32);

/** Key of the leak fingerprints: `<cacheDir>/fingerprint.key` (created 0600 once; a symbolic link is refused). */
export function loadFingerprintKey(cacheDir) {
  const file = path.join(cacheDir, 'fingerprint.key');
  try {
    if (lstatSync(file).isFile()) fingerprintKey = readFileSync(file);
    return;
  } catch {
    /* absent: created below */
  }
  const key = randomBytes(32);
  try {
    writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
    fingerprintKey = key;
  } catch {
    fingerprintKey = key; // read-only cache: fingerprints stable for this run only
  }
}

export function setFingerprintKey(key) {
  fingerprintKey = Buffer.from(key);
}

export function fingerprint(value) {
  return `hmac:${createHmac('sha256', fingerprintKey).update(value).digest('hex').slice(0, 16)}`;
}

/** Regular files under `dir` (symbolic links skipped, depth ≤ 3), sorted. */
export function listLogFiles(dir, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  let names;
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

/** The directory to read: `source` itself, or a private copy of the validation files of a tar archive (`cleanup` removes it). */
export function openLogSource(source) {
  if (!ARCHIVE_PATTERN.test(source)) return { dir: source, cleanup: () => undefined };
  const { dir, cleanup } = extractValidationFiles(source);
  return { dir, cleanup };
}

async function* readLines(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let number = 0;
  for await (const line of rl) {
    number += 1;
    yield { line, number };
  }
}

/**
 * Parsed trace lines of the `validation-*.jsonl` files, filtered by time (`since`, ms) and `env`, with read statistics.
 * The daily-cap markers are counted BEFORE the env filter (within the time window): a cap is never hidden by `--env`.
 */
export async function readTraceLines(files, { since = null, env } = {}) {
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
      if (typeof entry?.check !== 'string' || (since && !(Date.parse(entry.ts) >= since))) continue;
      if (entry.check === 'validation.trace.capped') stats.capped.push({ file: path.basename(file), traceClass: entry.fields?.traceClass ?? 'all', ts: entry.ts });
      if (env && entry.env !== env) continue;
      stats.lines += 1;
      lines.push({ entry, raw: line, file, number });
    }
  }
  return { lines, stats };
}

/**
 * Leak detectors. `high` fails the report; the shapes that also occur in harmless application logs (hashes, e-mails)
 * are `high` only in validation files, where the sanitizer must have removed them. Each pattern starts at a run
 * boundary (look-behind) and bounds its repetitions: linear time on hostile lines.
 */
const NOT_A_VALUE = /^(\[redacted|\*{3}|hmac:|sha256:|<redacted>|redacted$|undefined$|null$|true$|false$)/i;
export const LEAK_PATTERNS = [
  { type: 'jwt', regex: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, severity: () => 'high' },
  { type: 'bearer', regex: /(?<![A-Za-z0-9])bearer\s{1,16}([A-Za-z0-9._~+/=-]{16,})/gi, group: 1, severity: () => 'high' },
  {
    type: 'prefixed-token',
    regex: /(?<![A-Za-z0-9_-])(?:(?:tk|ctd|mst|ac_live|ac_test|sup|acs|ahe|ahf|ahi|ahr|sk_live|sk_test|rk_live|pk_live|whsec|ghp|gho|ghs|ghu|github_pat|npm)_|sk-|glpat-|xox[bpas]-|xapp-|xkeysib-|AIza)([A-Za-z0-9_-]{12,})/g,
    accept: (match) => /[0-9A-Z]/.test(match[1]),
    severity: () => 'high',
  },
  { type: 'aws-key', regex: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g, severity: () => 'high' },
  { type: 'private-key', regex: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g, severity: () => 'high' },
  { type: 'url-credentials', regex: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/"']{1,256}:([^\s@/"']{1,256})@/gi, group: 1, accept: (m) => !NOT_A_VALUE.test(m[1]), severity: () => 'high' },
  {
    type: 'credential-assignment',
    regex: /(?<![A-Za-z0-9_])(?:password|passwd|pwd|pphrase|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s{0,16}[:=]\s{0,16}["']?([^\s"',;&}]{4,256})/gi,
    group: 1,
    accept: (match) => !NOT_A_VALUE.test(match[1]),
    severity: () => 'high',
  },
  {
    type: 'email',
    regex: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24})(?![A-Za-z0-9-])/g,
    accept: (match) => !/^(noreply|no-reply|postmaster)$/i.test(match[1]) && !/^example\.(com|org|net|fr)$/i.test(match[2]),
    severity: (inValidation) => (inValidation ? 'high' : 'medium'),
  },
  { type: 'hex-secret', regex: /(?<![A-Za-z0-9])(?:0x)?[0-9a-fA-F]{64}(?![A-Za-z0-9])/g, severity: (v) => (v ? 'high' : 'low') },
  {
    type: 'base64-blob',
    regex: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}/g,
    accept: (match) => /[0-9]/.test(match[0]) && /[A-Z]/.test(match[0]) && /[a-z]/.test(match[0]),
    severity: (v) => (v ? 'high' : 'low'),
  },
];

function chunksOf(text) {
  if (text.length <= CHUNK) return [text];
  const chunks = [];
  for (let at = 0; at < text.length; at += CHUNK - OVERLAP) chunks.push(text.slice(at, at + CHUNK));
  return chunks;
}

/** Secret-looking values of one line: type, severity, length, fingerprint (≥ 12 characters only), never the value. */
export function findLeaks(text, inValidation) {
  const found = new Map();
  for (const chunk of chunksOf(text)) {
    for (const pattern of LEAK_PATTERNS) {
      for (const match of chunk.matchAll(pattern.regex)) {
        if (pattern.accept && !pattern.accept(match)) continue;
        const value = match[pattern.group ?? 0];
        const fp = value.length >= MIN_FINGERPRINT_LENGTH ? fingerprint(value) : null;
        const key = `${pattern.type}|${fingerprint(value)}`;
        if (!found.has(key)) found.set(key, { type: pattern.type, severity: pattern.severity(inValidation), fingerprint: fp, length: value.length, secretKey: key });
      }
    }
  }
  return [...found.values()];
}

/** Same line with every secret-looking value replaced by `[<type>]` (or `[<type> hmac:…]` for long values). */
export function scrubForDisplay(text) {
  let out = text;
  for (const pattern of LEAK_PATTERNS) {
    out = out.replace(pattern.regex, (...args) => {
      const match = args.slice(0, -2);
      if (pattern.accept && !pattern.accept(match)) return match[0];
      return match[0].length >= MIN_FINGERPRINT_LENGTH ? `[${pattern.type} ${fingerprint(match[0])}]` : `[${pattern.type}]`;
    });
  }
  return out;
}

/**
 * Leak scan of every log file (validation or not). `relativeTo` shortens the file names shown. `identity` (follow-up
 * state) is the fingerprint for long values, the location for short ones (no fingerprint of a short value is stored).
 */
export async function scanLeaks(files, relativeTo) {
  const findings = [];
  for (const file of files) {
    const inValidation = VALIDATION_FILE.test(path.basename(file));
    const rel = path.relative(relativeTo, file);
    for await (const { line, number } of readLines(file)) {
      for (const { secretKey, ...leak } of findLeaks(line, inValidation)) {
        findings.push({ file: rel, line: number, ...leak, identity: leak.fingerprint ? secretKey : `${leak.type}|short|${rel}:${number}` });
      }
    }
  }
  return findings;
}
