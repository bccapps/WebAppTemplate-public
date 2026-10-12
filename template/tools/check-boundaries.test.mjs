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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { collectEdges, extractSpecifiers, findViolations, main } from './check-boundaries.mjs';

function makeTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'cb-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
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

test('extractSpecifiers handles from/import()/require/export-from/side-effect and skips comments', () => {
  const src = [
    "import { a } from 'x';",
    "export * from './y';",
    "const z = await import('@/modules_shared/user/Z');",
    "const r = require('../user/R');",
    "import 'side-effect';",
    "// import { c } from 'commented';",
    'import {',
    '  b,',
    "} from 'multi';",
  ].join('\n');
  const specs = extractSpecifiers(src);
  assert.deepEqual(specs.map((s) => s.spec), ['x', './y', '@/modules_shared/user/Z', '../user/R', 'side-effect', 'multi']);
  assert.equal(specs.at(-1).line, 9);
});

test('collects edges in all supported specifier styles', () => {
  const root = makeTree({
    'nest/common/a.ts': "import { x } from 'modules_shared/user/X';\nimport y from '../database/Y';",
    'nest/common/sub/b.ts': "import z from '../../voice/Z';\nimport own from '../a';\nimport p from '@/modules_shared/common/P';",
    'nest/common/c.ts': "import k from '../../../outside';\nimport s from 'src/modules_shared/oauth/O';",
    'nest/user/node_modules/ignored.ts': "import x from '../../common/N';",
    'nest/database/d.ts': '',
    'nest/voice/v.ts': '',
  });
  const edges = collectEdges(path.join(root, 'nest'), 'nest');
  assert.deepEqual(
    edges.map((e) => `${e.file}:${e.line}>${e.to}`).sort(),
    ['a.ts:1>user', 'a.ts:2>database', 'c.ts:2>oauth', 'sub/b.ts:1>voice'].sort(),
  );
  rmSync(root, { recursive: true });
});

test('violations: allowed -> non-allowed or absent; non-allowed sources are free', () => {
  const root = makeTree({
    'nest/common/a.ts': "import u from 'modules_shared/user/U';\nimport d from '../database/D';",
    'nest/database/d.ts': '',
    'nest/user/u.ts': "import c from '../common/C';\nimport g from '@/modules_shared/ghost/G';",
    'nest/common/b.ts': "import g from '@/modules_shared/ghost/G';",
  });
  const edges = collectEdges(path.join(root, 'nest'), 'nest');
  const bad = findViolations(edges, { nest: ['common', 'database'] });
  assert.deepEqual(bad.map((e) => `${e.from}/${e.file}>${e.to}`).sort(), ['common/a.ts>user', 'common/b.ts>ghost']);
  rmSync(root, { recursive: true });
});

test('CLI: new layout exit codes, legacy flat layout and --report', () => {
  const root = makeTree({
    'nest/common/a.ts': "import u from '../user/U';",
    'nest/user/U.ts': '',
    'react/common/a.tsx': "import c from '../common/x';",
    'allowed.json': JSON.stringify({ nest: ['common'], react: ['common'] }),
    'ok.json': JSON.stringify({ nest: [], react: ['common'] }),
  });
  const allowed = path.join(root, 'allowed.json');
  assert.equal(quiet(() => main(['--root', root, '--stack-dirs', 'nest,react', '--allowed', allowed])), 1);
  assert.equal(quiet(() => main(['--root', root, '--stack-dirs', 'nest,react', '--allowed', path.join(root, 'ok.json')])), 0);
  assert.equal(quiet(() => main(['--modules-dir', path.join(root, 'nest'), '--stack', 'nest', '--allowed', allowed])), 1);
  assert.equal(quiet(() => main(['--modules-dir', path.join(root, 'nest'), '--stack', 'nest', '--report'])), 0);
  assert.throws(() => main(['--root', root]), /--allowed/);
  rmSync(root, { recursive: true });
});
