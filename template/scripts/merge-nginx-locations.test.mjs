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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeNginxLocations } from './merge-nginx-locations.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF = 'server {\n  listen 80;\n  # @app-locations (front/nginx.locations.conf)\n  location / {}\n}\n';
const LOCATIONS = '  location /api/x/ {\n    proxy_buffering off;\n  }\n';

test('mergeNginxLocations replaces the marker line, keeps the rest', () => {
  assert.equal(mergeNginxLocations(CONF, LOCATIONS), 'server {\n  listen 80;\n  location /api/x/ {\n    proxy_buffering off;\n  }\n  location / {}\n}\n');
  assert.throws(() => mergeNginxLocations('server {}\n', LOCATIONS), /marker/);
});

test('the template nginx.conf carries the marker inside its server block', () => {
  const conf = readFileSync(path.join(HERE, '..', 'front', 'nginx.conf'), 'utf8');
  const merged = mergeNginxLocations(conf, LOCATIONS);
  assert.ok(merged.indexOf('location /api/x/') < merged.indexOf('location /api/ {'), 'app locations come before the generic /api/');
});

test('CLI: no locations file is a no-op, a merge rewrites nginx.conf', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nginx-'));
  const conf = path.join(dir, 'nginx.conf');
  const locations = path.join(dir, 'nginx.locations.conf');
  writeFileSync(conf, CONF);
  const run = () => spawnSync('node', [path.join(HERE, 'merge-nginx-locations.mjs'), conf, locations], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.equal(readFileSync(conf, 'utf8'), CONF);
  writeFileSync(locations, LOCATIONS);
  assert.equal(run().status, 0);
  assert.match(readFileSync(conf, 'utf8'), /location \/api\/x\//);
  assert.equal(run().status, 1, 'marker already consumed: a second merge fails loudly');
});
