/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeNginxLocations } from './merge-nginx-locations.mjs';
import { blocksMissingSecurityHeaders, headerBlocks, SECURITY_HEADERS } from './nginx-security-headers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF = readFileSync(path.join(HERE, '..', 'front', 'nginx.conf'), 'utf8');

test('the template nginx.conf: every block that adds headers keeps the security headers (add_header inheritance)', () => {
  assert.deepEqual(blocksMissingSecurityHeaders(CONF), []);
  const blocks = headerBlocks(CONF);
  const server = blocks.find(({ block }) => block.startsWith('server'));
  for (const name of SECURITY_HEADERS) assert.ok(server.headers.includes(name), `server block sends ${name}`);
  // The SPA itself, its PWA files and assets, and the OAuth consent / error pages set their own headers.
  for (const location of ['location /', 'location ~ ^/(sw\\.js|registerSW\\.js|manifest\\.webmanifest)$', 'location ~* ^/oauth/consent/?$', 'location ~* ^/oauth/error/?$']) {
    const found = blocks.find(({ block }) => block === location);
    assert.ok(found, `${location} exists`);
    for (const name of SECURITY_HEADERS) assert.ok(found.headers.includes(name), `${location} sends ${name}`);
  }
});

test('the OAuth consent and error pages: never framed, never cached, the report-only CSP kept', () => {
  for (const location of ['location ~* ^/oauth/consent/?$', 'location ~* ^/oauth/error/?$']) {
    const { headers } = headerBlocks(CONF).find(({ block }) => block === location);
    for (const name of ['Content-Security-Policy', 'Content-Security-Policy-Report-Only', 'X-Frame-Options', 'Cross-Origin-Opener-Policy', 'Cache-Control']) assert.ok(headers.includes(name), `${location} sends ${name}`);
  }
  assert.match(CONF, /map \$host \$vx_csp_report_only \{\s*default "default-src 'self';[^"]*frame-ancestors 'none';";\s*\}/);
});

test('the guard flags a block whose own add_header drops the server headers (the bug it prevents)', () => {
  const regressed = CONF.replace(/(location \/ \{[\s\S]*?)add_header X-Frame-Options "DENY" always;\n/, '$1');
  assert.deepEqual(blocksMissingSecurityHeaders(regressed), [{ block: 'location /', missing: ['X-Frame-Options'] }]);
  const appBlock = '  location /x/ {\n    add_header Cache-Control "no-store" always; # add_header X-Frame-Options "DENY";\n  }\n';
  assert.deepEqual(blocksMissingSecurityHeaders(mergeNginxLocations(CONF, appBlock)), [{ block: 'location /x/', missing: [...SECURITY_HEADERS] }]);
  // A location without any add_header inherits the server block's: fine.
  assert.deepEqual(blocksMissingSecurityHeaders(mergeNginxLocations(CONF, '  location /y/ {\n    return 404;\n  }\n')), []);
});
