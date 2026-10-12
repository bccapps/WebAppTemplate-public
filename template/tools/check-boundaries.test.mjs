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
import { checkManifests, collectEdges, extractSpecifiers, findViolations, main, validateManifest } from './check-boundaries.mjs';

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

const mf = (id, over = {}) =>
  JSON.stringify({ id, title: id, description: 'd', visibility: 'public', category: 'core', requires: [], env: [], questions: [], ...over });

test('validateManifest: schema errors are listed, a valid manifest passes', () => {
  assert.deepEqual(validateManifest(JSON.parse(mf('voice', { requires: ['common'] })), 'voice', 'public'), []);
  const errors = validateManifest({ id: 'x', title: '', visibility: 'secret', category: 'misc', requires: ['voice', 'voice'], env: ['bad'], questions: [{}], extra: 1 }, 'voice', 'public').join(' | ');
  for (const part of ['missing key "description"', 'unknown key "extra"', 'must equal the directory name', 'non-empty string', 'visibility must be', 'category must be', 'cannot require itself', 'duplicate', 'UPPER_SNAKE_CASE', 'questions[0]']) {
    assert.ok(errors.includes(part), `expected "${part}" in: ${errors}`);
  }
  assert.match(validateManifest(JSON.parse(mf('a', { visibility: 'private' })), 'a', 'public').join(), /this repository is public/);
});

test('checkManifests: missing manifest, import not in requires (error), unused requires (warning), external modules', () => {
  const root = makeTree({
    'nest/common/module.json': mf('common'),
    'nest/common/a.ts': '',
    'nest/voice/module.json': mf('voice', { requires: ['common', 'database'] }),
    'nest/voice/v.ts': "import c from '../common/C';\nimport u from '../user/U';",
    'nest/database/d.ts': '',
    'nest/user/module.json': mf('user', { requires: ['common', 'oauth'] }),
    'nest/user/u.ts': "import c from '../common/C';\nimport o from '../oauth/O';",
  });
  const roots = [{ stack: 'nest', dir: path.join(root, 'nest') }];
  const edges = collectEdges(roots[0].dir, 'nest');
  const r = checkManifests(roots, edges, { visibility: 'public', external: { nest: ['oauth'] } });
  assert.ok(r.errors.some((e) => e.includes('nest/database/module.json: missing manifest')));
  assert.ok(r.errors.some((e) => e.includes('voice') && e.includes('imports "user" but it is not listed in requires')));
  assert.ok(r.warnings.some((w) => w.includes('requires "database" but never imports it')));
  assert.ok(!r.errors.some((e) => e.includes('nest/user')), 'external module accepted as a requires target');
  assert.equal(checkManifests(roots, edges, { visibility: 'public', external: { nest: ['oauth'] }, strictRequires: true }).errors.some((e) => e.includes('never imports')), true);
  rmSync(root, { recursive: true });
});

test('--check-manifests through main(): exit codes', () => {
  const ok = makeTree({ 'nest/common/module.json': mf('common'), 'nest/common/a.ts': '' });
  assert.equal(quiet(() => main(['--root', ok, '--stack-dirs', 'nest', '--check-manifests', '--visibility', 'public'])), 0);
  const bad = makeTree({ 'nest/common/a.ts': '' });
  assert.equal(quiet(() => main(['--root', bad, '--stack-dirs', 'nest', '--check-manifests'])), 1);
  rmSync(ok, { recursive: true });
  rmSync(bad, { recursive: true });
});
