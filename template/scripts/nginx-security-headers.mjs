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
 * `X-Content-Type-Options` other than nosniff, `Referrer-Policy` unsafe-url / no-referrer-when-downgrade, an empty report-only CSP) or lacks
 * `always` (without it nginx omits the header on error responses). It also refuses `add_header_inherit` (it changes the replace-not-merge
 * inheritance this guard models) and any `add_header` statement it cannot parse (a line the check would silently skip).
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

/** Referrer-Policy tokens that leak the full URL (or send it over a downgrade): refused. */
const LEAKY_REFERRER_TOKENS = new Set(['unsafe-url', 'no-referrer-when-downgrade']);

/**
 * Acceptable values of the headers whose value matters (case-insensitive; a variable is accepted only where a value cannot be
 * checked anyway: the report-only CSP, which just has to be non-empty).
 */
export const SECURITY_HEADER_VALUES = Object.freeze({
  'x-content-type-options': (value) => /^nosniff$/i.test(value),
  'x-frame-options': (value) => /^(DENY|SAMEORIGIN)$/i.test(value),
  'referrer-policy': (value) => {
    const tokens = value.split(',').map((token) => token.trim().toLowerCase());
    return tokens.every((token) => token !== '') && !tokens.some((token) => LEAKY_REFERRER_TOKENS.has(token));
  },
  'content-security-policy-report-only': (value) => value.trim() !== '',
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
  const stack = [{ header: '(top level)', details: [], extras: { inherit: [], unparsed: [] } }];
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
      stack.push({ header, details: [], extras: { inherit: [], unparsed: [] } });
      start = i + 1;
    } else if (char === '}') {
      const own = stack.length > 1 ? stack.pop() : null;
      if (own && /^(server|location|if)\b/.test(own.header)) blocks.push({ block: own.header.replace(/\s+/g, ' '), headers: own.details.map(({ name }) => name), details: own.details, ...own.extras });
      else if (own && (own.extras.inherit.length > 0 || own.extras.unparsed.length > 0)) blocks.push({ block: own.header.replace(/\s+/g, ' '), headers: [], details: [], ...own.extras });
      start = i + 1;
    } else if (char === ';') {
      const statement = text.slice(start, i).trim().replace(/\s+/g, ' ');
      const top = stack[stack.length - 1];
      const match = ADD_HEADER.exec(statement);
      if (/^add_header_inherit\b/.test(statement)) top.extras.inherit.push(statement.slice(0, 80));
      else if (match) {
        if (stack.length > 1) top.details.push({ name: unquoted(match[1]), value: unquoted(match[2]), always: match[3] === 'always' });
      } else if (/^add_header\b/.test(statement)) top.extras.unparsed.push(statement.slice(0, 80));
      start = i + 1;
    }
  }
  const root = stack[0];
  if (root.extras.inherit.length > 0 || root.extras.unparsed.length > 0) blocks.push({ block: root.header, headers: [], details: [], ...root.extras });
  return blocks;
}

/**
 * Blocks that set their own headers but, for a security header, miss it (`missing`), send a value that defeats it (`invalid`:
 * `"Name: value"`) or send it without `always` (`withoutAlways`); `inherit` = `add_header_inherit` statements, `unparsed` = `add_header`
 * statements the guard cannot read. Only the non-empty lists are present.
 */
export function blocksMissingSecurityHeaders(conf) {
  return headerBlocks(conf)
    .filter(({ headers, inherit, unparsed }) => headers.length > 0 || inherit.length > 0 || unparsed.length > 0)
    .map(({ block, details, headers, inherit, unparsed }) => {
      const problems = { block, missing: [], invalid: [], withoutAlways: [], inherit, unparsed };
      for (const name of headers.length > 0 ? SECURITY_HEADERS : []) {
        const sent = details.filter((detail) => detail.name.toLowerCase() === name.toLowerCase());
        if (sent.length === 0) problems.missing.push(name);
        const accepted = SECURITY_HEADER_VALUES[name.toLowerCase()];
        if (accepted) for (const { value } of sent) if (!accepted(value)) problems.invalid.push(`${name}: ${value}`);
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
  for (const { block, missing = [], invalid = [], withoutAlways = [], inherit = [], unparsed = [] } of problems) {
    const parts = [
      missing.length > 0 ? `missing ${missing.join(', ')} (its own add_header drops the level above's)` : '',
      invalid.length > 0 ? `unsafe value ${invalid.join(', ')}` : '',
      withoutAlways.length > 0 ? `without "always" ${withoutAlways.join(', ')} (not sent on error responses)` : '',
      inherit.length > 0 ? `add_header_inherit is not supported by this guard (${inherit.join(' | ')})` : '',
      unparsed.length > 0 ? `unreadable add_header (${unparsed.join(' | ')})` : '',
    ].filter(Boolean);
    console.error(`✖ ${block}: ${parts.join('; ')}`);
  }
  return problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))) {
  process.exit(main(process.argv.slice(2)));
}
