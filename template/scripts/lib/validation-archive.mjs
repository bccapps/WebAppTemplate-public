/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Extraction of the validation trace files of a tar archive (`.tar`, `.tar.gz`, `.tgz`) WITHOUT `tar`: the archive is
 * read in memory (bounded), only REGULAR file members whose base name is `validation-YYYY-MM-DD.jsonl` are written,
 * each to `<private temp dir>/<n>/<base name>` with an exclusive create (`wx`, 0600). Links, devices, directories and
 * every other member are ignored: no member can write or read outside the temporary directory, whatever its name or
 * link target. Zero dependencies, ESM.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const ARCHIVE_PATTERN = /\.(tar\.gz|tgz|tar)$/i;
const VALIDATION_FILE = /^validation-\d{4}-\d{2}-\d{2}\.jsonl$/;
/** Largest archive accepted, compressed and uncompressed. */
export const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
const BLOCK = 512;

function cString(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function octal(buf, start, length) {
  const text = cString(buf, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('corrupt tar header');
  return text ? Number.parseInt(text, 8) : 0;
}

/** `path=` record of a pax extended header. */
function paxPath(content) {
  for (const record of content.toString('utf8').split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) return match[1];
  }
  return null;
}

/** Regular-file members of a tar buffer: `{ name, data }` (GNU long names and pax `path` honoured, nothing else). */
export function regularMembers(tar) {
  const members = [];
  let offset = 0;
  let pendingName = null;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const start = offset + BLOCK;
    if (start + size > tar.length) throw new Error('truncated tar archive');
    const content = tar.subarray(start, start + size);
    const prefix = cString(header, 257, 6).startsWith('ustar') ? cString(header, 345, 155) : '';
    const name = pendingName ?? (prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100));
    pendingName = null;
    if (type === 'L') pendingName = cString(content, 0, content.length);
    else if (type === 'x') pendingName = paxPath(content);
    else if (type === '0' || type === '7') members.push({ name, data: content });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return members;
}

function readArchive(file) {
  if (statSync(file).size > MAX_ARCHIVE_BYTES) throw new Error(`archive larger than ${MAX_ARCHIVE_BYTES} bytes`);
  const raw = readFileSync(file);
  return /\.(tar\.gz|tgz)$/i.test(file) ? gunzipSync(raw, { maxOutputLength: MAX_ARCHIVE_BYTES }) : raw;
}

/** Base name of a member, `\\` (archives made on Windows) treated as a separator: the name that is checked is the name written. */
export function baseName(name) {
  return path.posix.basename(name.replace(/\\/g, '/'));
}

/**
 * Private copy of the validation files of an archive: `{ dir, files, cleanup }`. The temporary directory is removed
 * at once when anything fails.
 */
export function extractValidationFiles(file) {
  const dir = mkdtempSync(path.join(tmpdir(), 'validation-logs-'));
  try {
    const members = regularMembers(readArchive(file))
      .map((m) => ({ base: baseName(m.name), data: m.data }))
      .filter((m) => VALIDATION_FILE.test(m.base));
    members.forEach((member, index) => {
      const sub = path.join(dir, String(index));
      mkdirSync(sub, { mode: 0o700 });
      writeFileSync(path.join(sub, member.base), member.data, { flag: 'wx', mode: 0o600 });
    });
    return { dir, files: members.length, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
