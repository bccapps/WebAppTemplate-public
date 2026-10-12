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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildHeader, processText, run, main } from './license-headers.mjs';

const OLD_SOFTWARE = `/**
 * VX Framework — Proprietary Software
 *
 * Copyright © 2025–2026 Stéphane VAXELAIRE.
 * @license    Proprietary — See LICENSE.md
 */
`;
const OLD_COMPONENT = OLD_SOFTWARE.replace('Software', 'Component');
const OLD_SHELL = `# =============================================================================
# VX Framework — Proprietary Component
#
# @license    Proprietary — See LICENSE.md
# =============================================================================
`;

test('replaces block variants (Software and Component) and keeps the body', () => {
  for (const old of [OLD_SOFTWARE, OLD_COMPONENT]) {
    const res = processText(`${old}\nexport const a = 1;\n`, '.ts', 'mit');
    assert.equal(res.status, 'replaced');
    assert.equal(res.text, `${buildHeader('mit', 'block')}\n\nexport const a = 1;\n`);
  }
});

test('shell: keeps shebang, replaces banner only, ignores later banners', () => {
  const body = '\nset -e\n\n# ====\n# run.sh\n# ====\n';
  const res = processText(`#!/usr/bin/env bash\n\n${OLD_SHELL}${body}`, '.sh', 'mit');
  assert.ok(res.text.startsWith('#!/usr/bin/env bash\n\n# ====='));
  assert.ok(res.text.includes('SPDX-License-Identifier: MIT'));
  assert.ok(res.text.endsWith(body));
  assert.equal(res.variant, 'hash/proprietary-component');
});

test('adds a header (after shebang) when none, without touching other comments', () => {
  const ts = processText('/** Doc of the file. */\nexport {};\n', '.ts', 'mit');
  assert.equal(ts.status, 'added');
  assert.equal(ts.text, `${buildHeader('mit', 'block')}\n\n/** Doc of the file. */\nexport {};\n`);
  const sh = processText('#!/bin/sh\necho hi\n', '.sh', 'proprietary');
  assert.ok(sh.text.startsWith('#!/bin/sh\n\n# ====='));
  assert.ok(sh.text.endsWith('\necho hi\n'));
});

test('idempotent, and can convert back to proprietary', () => {
  const once = processText(`${OLD_SOFTWARE}\nx\n`, '.ts', 'mit').text;
  assert.equal(processText(once, '.ts', 'mit').status, 'unchanged');
  const back = processText(once, '.ts', 'proprietary');
  assert.equal(back.variant, 'block/mit');
  assert.ok(back.text.includes('VXFramework — Proprietary Software'));
  assert.equal(processText(back.text, '.ts', 'proprietary').status, 'unchanged');
});

test('unknown licence-like comment is unclassified and untouched', () => {
  const src = '/**\n * Copyright (c) Someone Else\n */\nexport {};\n';
  const res = processText(src, '.ts', 'mit');
  assert.equal(res.status, 'unclassified');
  assert.equal(res.text, src);
});

test('run(): skips node_modules, .d.ts and json; --check writes nothing and exits 1', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lh-'));
  const files = {
    'a/x.ts': `${OLD_SOFTWARE}\nx\n`,
    'a/y.css': 'body {}\n',
    'a/types.d.ts': 'export {};\n',
    'a/data.json': '{}',
    'node_modules/m/z.ts': 'export {};\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  const quiet = (fn) => {
    const log = console.log;
    console.log = () => {};
    try {
      return fn();
    } finally {
      console.log = log;
    }
  };
  assert.equal(quiet(() => main(['--root', root, '--license', 'mit', '--check'])), 1);
  assert.equal(readFileSync(path.join(root, 'a/x.ts'), 'utf8'), files['a/x.ts']);
  const res = run(root, 'mit');
  assert.equal(res.total, 2);
  assert.equal(res.changed.length, 2);
  assert.equal(readFileSync(path.join(root, 'a/types.d.ts'), 'utf8'), 'export {};\n');
  assert.equal(quiet(() => main(['--root', root, '--license', 'mit', '--check'])), 0);
  rmSync(root, { recursive: true });
});
