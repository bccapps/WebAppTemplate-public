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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mergeNginxLocations } from './merge-nginx-locations.mjs';
import { blocksMissingSecurityHeaders, headerBlocks, SECURITY_HEADERS } from './nginx-security-headers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF = readFileSync(path.join(HERE, '..', 'front', 'nginx.conf'), 'utf8');
const SCRIPT = path.join(HERE, 'nginx-security-headers.mjs');

/** The four security headers as a block repeats them (the template's own lines), optionally with one replaced. */
const four = (replace = {}) =>
  [
    ['X-Content-Type-Options', '"nosniff" always'],
    ['X-Frame-Options', '"DENY" always'],
    ['Referrer-Policy', '"strict-origin-when-cross-origin" always'],
    ['Content-Security-Policy-Report-Only', '$vx_csp_report_only always'],
  ]
    .map(([name, rest]) => (name in replace ? replace[name] : `    add_header ${name} ${rest};\n`))
    .join('');
const withLocation = (body) => `${CONF.replace(/\n  location \/api\/ \{/, `\n${body}\n  location /api/ {`)}`;

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

test('values: X-Frame-Options must be DENY or SAMEORIGIN, X-Content-Type-Options nosniff — a header that defeats itself is flagged', () => {
  const block = (replace) => withLocation(`  location /x/ {\n    add_header Cache-Control "no-store" always;\n${four(replace)}  }\n`);
  assert.deepEqual(blocksMissingSecurityHeaders(block({})), []);
  for (const ok of ['DENY', 'SAMEORIGIN', 'deny', 'sameorigin']) assert.deepEqual(blocksMissingSecurityHeaders(block({ 'X-Frame-Options': `    add_header X-Frame-Options "${ok}" always;\n` })), [], ok);
  for (const bad of ['ALLOWALL', 'ALLOW-FROM https://evil.example', '', '$http_x_frame', 'DENYX']) {
    const found = blocksMissingSecurityHeaders(block({ 'X-Frame-Options': `    add_header X-Frame-Options "${bad}" always;\n` }));
    assert.deepEqual(found, [{ block: 'location /x/', invalid: [`X-Frame-Options: ${bad}`] }], bad);
  }
  assert.deepEqual(blocksMissingSecurityHeaders(block({ 'X-Content-Type-Options': '    add_header X-Content-Type-Options "sniff" always;\n' })), [{ block: 'location /x/', invalid: ['X-Content-Type-Options: sniff'] }]);
  // Unquoted values and a duplicate header: every occurrence is checked.
  assert.deepEqual(blocksMissingSecurityHeaders(block({ 'X-Frame-Options': '    add_header X-Frame-Options SAMEORIGIN always;\n' })), []);
  assert.deepEqual(blocksMissingSecurityHeaders(block({ 'X-Frame-Options': '    add_header X-Frame-Options "DENY" always;\n    add_header X-Frame-Options "ALLOWALL" always;\n' })), [{ block: 'location /x/', invalid: ['X-Frame-Options: ALLOWALL'] }]);
  // The server block itself is held to it too.
  assert.deepEqual(blocksMissingSecurityHeaders(CONF.replace('add_header X-Frame-Options "DENY" always;\n  add_header Referrer', 'add_header X-Frame-Options "ALLOWALL" always;\n  add_header Referrer')).map(({ block, invalid }) => [block, invalid]), [['server', ['X-Frame-Options: ALLOWALL']]]);
});

test('always: a security header without `always` is flagged (it would vanish from error responses)', () => {
  const block = (replace) => withLocation(`  location /x/ {\n    add_header Cache-Control "no-store" always;\n${four(replace)}  }\n`);
  assert.deepEqual(blocksMissingSecurityHeaders(block({ 'X-Frame-Options': '    add_header X-Frame-Options "DENY";\n' })), [{ block: 'location /x/', withoutAlways: ['X-Frame-Options'] }]);
  assert.deepEqual(
    blocksMissingSecurityHeaders(block({ 'Content-Security-Policy-Report-Only': '    add_header Content-Security-Policy-Report-Only $vx_csp_report_only;\n', 'X-Content-Type-Options': '    add_header X-Content-Type-Options "nosniff";\n' })),
    [{ block: 'location /x/', withoutAlways: ['X-Content-Type-Options', 'Content-Security-Policy-Report-Only'] }],
  );
  // One occurrence with `always` does not excuse a duplicate without it.
  assert.deepEqual(blocksMissingSecurityHeaders(block({ 'X-Frame-Options': '    add_header X-Frame-Options "DENY" always;\n    add_header X-Frame-Options "DENY";\n' })), [{ block: 'location /x/', withoutAlways: ['X-Frame-Options'] }]);
  // A header other than the four may go without `always`.
  assert.deepEqual(blocksMissingSecurityHeaders(withLocation(`  location /x/ {\n    add_header Cache-Control "no-store";\n${four()}  }\n`)), []);
  // The server block: dropping `always` there is flagged as well.
  assert.deepEqual(blocksMissingSecurityHeaders(CONF.replace('add_header X-Content-Type-Options "nosniff" always;\n  add_header X-Frame-Options', 'add_header X-Content-Type-Options "nosniff";\n  add_header X-Frame-Options')).slice(0, 1), [{ block: 'server', withoutAlways: ['X-Content-Type-Options'] }]);
});

test('if blocks: an `if` that adds a header replaces the location\'s headers too, so it must repeat them; an `if` without add_header is ignored', () => {
  const location = (inside) => withLocation(`  location /x/ {\n${four()}    ${inside}\n  }\n`);
  // A location with its four headers whose `if` adds one header: the `if` drops them for the matching requests.
  const dropped = blocksMissingSecurityHeaders(location('if ($http_origin = "https://ok.example") {\n      add_header Access-Control-Allow-Origin "https://ok.example" always;\n    }'));
  assert.deepEqual(dropped, [{ block: 'if ($http_origin = "https://ok.example")', missing: [...SECURITY_HEADERS] }]);
  // The same `if` repeating the four headers is fine; so is an `if` with no add_header, a return or a rewrite.
  assert.deepEqual(blocksMissingSecurityHeaders(location(`if ($http_origin = "https://ok.example") {\n      add_header Access-Control-Allow-Origin "https://ok.example" always;\n${four()}    }`)), []);
  assert.deepEqual(blocksMissingSecurityHeaders(location('if ($request_method = OPTIONS) {\n      return 204;\n    }')), []);
  // A value problem and a missing `always` inside an `if` are reported on the `if`.
  const unsafe = blocksMissingSecurityHeaders(location(`if ($arg_x) {\n${four({ 'X-Frame-Options': '    add_header X-Frame-Options "ALLOWALL";\n' })}    }`));
  assert.deepEqual(unsafe, [{ block: 'if ($arg_x)', invalid: ['X-Frame-Options: ALLOWALL'], withoutAlways: ['X-Frame-Options'] }]);
  // An `if` at server level, and an `if` nested in an `if`, are walked too.
  const server = CONF.replace('  location /api/v1/events/ {', '  if ($http_x_debug) {\n    add_header X-Debug "1" always;\n  }\n  location /api/v1/events/ {');
  assert.deepEqual(blocksMissingSecurityHeaders(server).map(({ block }) => block), ['if ($http_x_debug)']);
  const nested = location('if ($a) {\n      if ($b) {\n        add_header X-Nested "1" always;\n      }\n    }');
  assert.deepEqual(blocksMissingSecurityHeaders(nested).map(({ block }) => block), ['if ($b)']);
  // The template itself has no such `if` problem, and `map`/`if` braces do not unbalance the walk of the rest.
  assert.deepEqual(blocksMissingSecurityHeaders(CONF), []);
});

test('the command exits 1 and names the problem (value, always, if) and 0 on the template', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nginx-headers-'));
  try {
    const run = (conf) => {
      const file = path.join(dir, 'nginx.conf');
      writeFileSync(file, conf);
      return spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    };
    const ok = run(CONF);
    assert.equal(ok.status, 0);
    const bad = run(withLocation(`  location /x/ {\n    add_header Cache-Control "no-store" always;\n${four({ 'X-Frame-Options': '    add_header X-Frame-Options "ALLOWALL";\n' })}    if ($a) {\n      add_header X-A "1" always;\n    }\n  }\n`));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /location \/x\/: unsafe value X-Frame-Options: ALLOWALL; without "always" X-Frame-Options/);
    assert.match(bad.stderr, /if \(\$a\): missing /);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
