#!/usr/bin/env node
/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * nginx `add_header` guard for front/nginx.conf (and an app's merged front/nginx.locations.conf).
 *
 * A block (server, location or `if`) that sets ANY `add_header` of its own drops EVERY `add_header` of the levels above it. The
 * template's security headers (server block) are therefore repeated in each location (and `if`) that adds a header; this lists
 * the blocks where one is missing, carries a value that defeats it (`X-Frame-Options` other than DENY / SAMEORIGIN,
 * `X-Content-Type-Options` other than nosniff) or lacks `always` (without it nginx omits the header on error responses).
 * Usage: `node scripts/nginx-security-headers.mjs <nginx.conf>` (exit 1 with the blocks).
 */

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Headers every block that adds headers must send (any value: a block may tighten one, e.g. Referrer-Policy). */
export const SECURITY_HEADERS = Object.freeze(['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Content-Security-Policy-Report-Only']);

/** Text without `#` comments (quotes respected), so a commented-out directive never counts. */
function stripComments(conf) {
  return conf
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (quote) {
          if (char === quote && line[i - 1] !== '\\') quote = null;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '#') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** Accepted values of the headers whose value matters (compared case-insensitively; a variable is not accepted: it cannot be checked). */
export const SECURITY_HEADER_VALUES = Object.freeze({
  'x-content-type-options': /^nosniff$/i,
  'x-frame-options': /^(DENY|SAMEORIGIN)$/i,
});

const ADD_HEADER = /^add_header\s+(\S+)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)(?:\s+(always))?\s*$/;
const unquoted = (token) => token.replace(/^["']|["']$/g, '');

/**
 * The `server`, `location` and `if` blocks of `conf`, each with the `add_header` directives set DIRECTLY in it (not in a nested
 * block): `headers` = their names, `details` = `{ name, value, always }`. Brace matching is quote-aware; `map` and other blocks are
 * walked but not reported. An `if` is reported like a location: nginx gives it its own `add_header` level too.
 */
export function headerBlocks(conf) {
  const text = stripComments(conf);
  const blocks = [];
  const stack = [];
  let start = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') {
      const header = text.slice(start, i).trim().split(';').pop().trim();
      stack.push({ header, details: [] });
      start = i + 1;
    } else if (char === '}') {
      const own = stack.pop();
      if (own && /^(server|location|if)\b/.test(own.header)) blocks.push({ block: own.header.replace(/\s+/g, ' '), headers: own.details.map(({ name }) => name), details: own.details });
      start = i + 1;
    } else if (char === ';') {
      const statement = text.slice(start, i).trim();
      const match = ADD_HEADER.exec(statement.replace(/\s+/g, ' '));
      if (match && stack.length > 0) stack[stack.length - 1].details.push({ name: unquoted(match[1]), value: unquoted(match[2]), always: match[3] === 'always' });
      start = i + 1;
    }
  }
  return blocks;
}

/**
 * Blocks that set their own headers but, for a security header, miss it (`missing`), send a value that defeats it (`invalid`:
 * `"Name: value"`) or send it without `always` (`withoutAlways`). Only the non-empty lists are present.
 */
export function blocksMissingSecurityHeaders(conf) {
  return headerBlocks(conf)
    .filter(({ headers }) => headers.length > 0)
    .map(({ block, details }) => {
      const problems = { block, missing: [], invalid: [], withoutAlways: [] };
      for (const name of SECURITY_HEADERS) {
        const sent = details.filter((detail) => detail.name.toLowerCase() === name.toLowerCase());
        if (sent.length === 0) problems.missing.push(name);
        const accepted = SECURITY_HEADER_VALUES[name.toLowerCase()];
        if (accepted) for (const { value } of sent) if (!accepted.test(value)) problems.invalid.push(`${name}: ${value}`);
        if (sent.some(({ always }) => !always)) problems.withoutAlways.push(name);
      }
      return Object.fromEntries(Object.entries(problems).filter(([key, list]) => key === 'block' || list.length > 0));
    })
    .filter((problems) => Object.keys(problems).length > 1);
}

function main([file]) {
  if (!file) {
    console.error('usage: nginx-security-headers.mjs <nginx.conf>');
    return 2;
  }
  const problems = blocksMissingSecurityHeaders(readFileSync(file, 'utf8'));
  for (const { block, missing = [], invalid = [], withoutAlways = [] } of problems) {
    const parts = [
      missing.length > 0 ? `missing ${missing.join(', ')} (its own add_header drops the level above's)` : '',
      invalid.length > 0 ? `unsafe value ${invalid.join(', ')}` : '',
      withoutAlways.length > 0 ? `without "always" ${withoutAlways.join(', ')} (not sent on error responses)` : '',
    ].filter(Boolean);
    console.error(`✖ ${block}: ${parts.join('; ')}`);
  }
  return problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))) {
  process.exit(main(process.argv.slice(2)));
}
