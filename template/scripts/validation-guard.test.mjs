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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'validation-guard.sh');

/** Runs vg_guard_prod_env (under deploy-full.sh's `set -euo pipefail`) on a staged copy of `content`, the source file being named `sourceName`. */
function guard(sourceName, content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vguard-'));
  const source = path.join(dir, sourceName);
  const staged = path.join(dir, 'staged.env');
  writeFileSync(source, content);
  writeFileSync(staged, content);
  const res = spawnSync('bash', ['-c', `set -euo pipefail; source "${LIB}"; vg_guard_prod_env "$1" "$2"`, 'guard', source, staged], { encoding: 'utf8' });
  const out = { status: res.status, stderr: res.stderr, staged: readFileSync(staged, 'utf8') };
  rmSync(dir, { recursive: true });
  return out;
}

const lastValue = (text, key) => text.split('\n').filter((l) => l.startsWith(`${key}=`)).pop()?.split('=')[1];

test('a production deploy (back/.env) always ships VALIDATION_TRACE=off, quietly when APP_ENV=prod', () => {
  const res = guard('.env', 'APP_ENV=prod\nVALIDATION_TRACE=on\n');
  assert.equal(res.status, 0);
  assert.equal(lastValue(res.staged, 'VALIDATION_TRACE'), 'off');
  assert.equal(res.stderr, '');
});

test('a production deploy with APP_ENV=dev (copied example) or unset warns loudly and still succeeds', () => {
  for (const content of ['APP_ENV=dev\n', 'APP_ENV="staging"\n', 'PROJECT_NAME=x\n']) {
    const res = guard('.env', content);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /WARNING: deploy of .* with APP_ENV=.* treated as production: set APP_ENV=prod/);
    assert.equal(lastValue(res.staged, 'VALIDATION_TRACE'), 'off');
  }
});

test('a preprod deploy (back/.env.preprod, or APP_ENV=preprod in any file) is left untouched', () => {
  for (const [name, content] of [['.env.preprod', 'APP_ENV=preprod\nVALIDATION_TRACE=on\n'], ['.env.custom', 'export APP_ENV="Preprod" # staging box\nVALIDATION_TRACE=on\n']]) {
    const res = guard(name, content);
    assert.equal(res.status, 0);
    assert.equal(res.staged, content);
    assert.equal(res.stderr, '');
  }
});

test('the file name alone never makes a deploy non-production: any other env file is forced off', () => {
  for (const [name, content] of [['.env.production', 'APP_ENV=dev\nVALIDATION_TRACE=on\n'], ['.env.staging', 'APP_ENV=prod\n'], ['.env.dev', 'APP_ENV=dev\n']]) {
    const res = guard(name, content);
    assert.equal(res.status, 0);
    assert.equal(lastValue(res.staged, 'VALIDATION_TRACE'), 'off', name);
  }
});
