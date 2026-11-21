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
 * nginx `add_header` inheritance guard for front/nginx.conf (and an app's merged front/nginx.locations.conf).
 *
 * A block (server or location) that sets ANY `add_header` of its own drops EVERY `add_header` of the levels above it. The
 * template's security headers (server block) are therefore repeated in each location that adds a header; this lists the
 * blocks where one is missing. Usage: `node scripts/nginx-security-headers.mjs <nginx.conf>` (exit 1 with the blocks).
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

/**
 * The `server` and `location` blocks of `conf`, each with the `add_header` names set DIRECTLY in it (not in a nested block).
 * Brace matching is quote-aware; `map`/`if`/other blocks are walked but not reported.
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
      stack.push({ header, own: [] });
      start = i + 1;
    } else if (char === '}') {
      const own = stack.pop();
      if (own && /^(server|location)\b/.test(own.header)) blocks.push({ block: own.header.replace(/\s+/g, ' '), headers: own.own });
      start = i + 1;
    } else if (char === ';') {
      const statement = text.slice(start, i).trim();
      const match = /^add_header\s+(\S+)/.exec(statement);
      if (match && stack.length > 0) stack[stack.length - 1].own.push(match[1].replace(/^["']|["']$/g, ''));
      start = i + 1;
    }
  }
  return blocks;
}

/** Blocks that set their own headers but miss a security header (they would serve the response without it). */
export function blocksMissingSecurityHeaders(conf) {
  return headerBlocks(conf)
    .filter(({ headers }) => headers.length > 0)
    .map(({ block, headers }) => ({ block, missing: SECURITY_HEADERS.filter((name) => !headers.some((header) => header.toLowerCase() === name.toLowerCase())) }))
    .filter(({ missing }) => missing.length > 0);
}

function main([file]) {
  if (!file) {
    console.error('usage: nginx-security-headers.mjs <nginx.conf>');
    return 2;
  }
  const problems = blocksMissingSecurityHeaders(readFileSync(file, 'utf8'));
  for (const { block, missing } of problems) console.error(`✖ ${block}: missing ${missing.join(', ')} (its own add_header drops the server block's)`);
  return problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))) {
  process.exit(main(process.argv.slice(2)));
}
