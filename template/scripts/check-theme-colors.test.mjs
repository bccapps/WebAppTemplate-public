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
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { audit, findLiterals, isExempt, overBaseline } from './check-theme-colors.mjs';

const texts = (src, ext = '.css') => findLiterals(src, ext, { allowFallbacks: true }).map((h) => h.text);

test('findLiterals: hex and functional colors in a declaration', () => {
  assert.deepEqual(texts('a { color: #fff; background: #1a2b3c; border-color: #1a2b3c80; }'), ['#fff', '#1a2b3c', '#1a2b3c80']);
  assert.deepEqual(texts('a { box-shadow: 0 0 4px rgba(0,0,0,.4), 0 0 1px rgb(1 2 3); color: hsl(10 50% 50%); }'), ['rgba(', 'rgb(', 'hsl(']);
});

test('findLiterals: a token read, a rgba over a channel token and a fallback are not literals', () => {
  assert.deepEqual(texts('a { color: var(--c); background: rgba(var(--ac-accent-rgb), 0.35); }'), []);
  assert.deepEqual(texts('a { color: var(--st-error, #f44336); border: 1px solid var(--ac-border, rgba(128,128,128,0.25)); }'), []);
  assert.deepEqual(texts('a { color: var(--a, var(--b, #123456)); }'), []);
  // the fallback is exempt, what follows it on the line is not
  assert.deepEqual(texts('a { background: var(--bg, #000) #fff; }'), ['#fff']);
});

test('findLiterals: the fallback of a var() counts, unless allowFallbacks', () => {
  const css = 'a { color: var(--st-error, #f44336); border: 1px solid var(--b, rgba(1,2,3,.2)); }';
  assert.deepEqual(findLiterals(css, '.css').map((h) => h.text), ['#f44336', 'rgba(']);
  assert.deepEqual(findLiterals(css, '.css', { allowFallbacks: true }), []);
});

test('findLiterals: comments, ids, entities and unknown hex lengths are ignored', () => {
  assert.deepEqual(texts('/* color: #fff; */ a { color: var(--c); } /* rgba(0,0,0,1) */'), []);
  assert.deepEqual(texts('#header, #abc { margin: 0 }'), []);
  assert.deepEqual(texts('#header,\n#abc\n{ margin: 0 }'), []);
  assert.deepEqual(texts('a {\n  background:\n    linear-gradient(0deg, color-mix(in srgb, var(--bg) 85%, #000) 0, red),\n    #fff;\n}'), ['#000', '#fff']);
  assert.deepEqual(texts('a#fade:hover { margin: 0 }'), []);
  assert.deepEqual(texts('const a = 1; // #fff and rgba(0,0,0,1)', '.ts'), []);
  assert.deepEqual(texts("const e = '&#123;'; const u = 'https://x.y/#abc';", '.ts'), []);
  assert.deepEqual(texts('a { color: #12345; }'), []);
});

test('findLiterals: TSX strings are found, with line and column', () => {
  const hits = findLiterals("const a = 1;\n<Box sx={{ bgcolor: '#0a0d12', color: 'var(--ac-text)' }} />", '.tsx');
  assert.deepEqual(hits, [{ line: 2, col: 22, text: '#0a0d12' }]);
});

test('findLiterals: theme-colors-ignore on the line or the line before, theme-colors-ignore-file at the top', () => {
  assert.deepEqual(texts("a = '#fff'; // theme-colors-ignore: data", '.ts'), []);
  assert.deepEqual(texts("// theme-colors-ignore: data\nconst a = '#fff';\nconst b = '#000';", '.ts'), ['#000']);
  assert.deepEqual(texts("// theme-colors-ignore-file: palette\nconst a = '#fff';", '.ts'), []);
  assert.deepEqual(texts(`/**\n${' *\n'.repeat(20)} */\n// theme-colors-ignore-file: palette\nconst a = '#fff';`, '.ts'), []);
  assert.deepEqual(texts('/* theme-colors-ignore */ a { color: #fff }\na { color: #eee }\na { color: #000 }'), ['#000']);
});

test('isExempt: token files, the app theme folder, specs and declarations', () => {
  assert.equal(isExempt('front/src/modules/x/styles/tokens.css'), true);
  assert.equal(isExempt('front/src/themes/app/colors.css'), true);
  assert.equal(isExempt('front/src/modules/x/Card.spec.tsx'), true);
  assert.equal(isExempt('front/src/modules/x/Card.test.ts'), true);
  assert.equal(isExempt('front/src/vite-env.d.ts'), true);
  assert.equal(isExempt('front/.libs/vx-private/react/user/components/ui/account/accountTokens.css'), true);
  assert.equal(isExempt('front/.libs/vx-public/react/common/themes/default/theme.css'), true);
  assert.equal(isExempt('front/src/modules/x/Card.tsx'), false);
  assert.equal(isExempt('front/src/modules/x/styles/x.css'), false);
});

test('overBaseline: only the files above their recorded count', () => {
  const files = { a: [1, 2, 3], b: [1], c: [1, 2] };
  assert.deepEqual(overBaseline(files, { a: 3, b: 0 }), [
    { file: 'b', count: 1, allowed: 0 },
    { file: 'c', count: 2, allowed: 0 },
  ]);
  assert.equal(overBaseline(files, {}).length, 3);
});

test('audit: scans front/src, skips themes, tokens, symlinked libraries and ignored paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tcc-'));
  const put = (rel, body) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  put('front/src/modules/m/Card.tsx', "export const c = { color: '#abcdef' }");
  put('front/src/modules/m/Ok.tsx', "export const c = { color: 'var(--m-card-fg)' }");
  put('front/src/modules/m/styles/tokens.css', ':where(:root) { --m-card-fg: #fff; }');
  put('front/src/themes/app/colors.css', ':root { --x: #000; }');
  put('front/src/modules/engine/draw.ts', "export const c = '#123456'");
  put('library/Lib.tsx', "export const c = '#fedcba'");
  symlinkSync(path.join(root, 'library'), path.join(root, 'front/src/modules_shared'));

  const { files, total } = audit(root, { ignore: ['^front/src/modules/engine/'] });
  assert.deepEqual(Object.keys(files), ['front/src/modules/m/Card.tsx']);
  assert.equal(total, 1);
});

test('audit: --libs scans the real directories of the linked shared modules', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tcc-libs-'));
  const put = (rel, body) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  put('front/src/App.tsx', "export const a = 'var(--x)'");
  put('front/.libs/vx-public/react/common/Card.tsx', "export const c = '#abcdef'");
  put('front/.libs/vx-public/react/common/styles/tokens.css', ':where(:root) { --c: #fff; }');
  put('front/.libs/vx-public/react/other/Skip.tsx', "export const c = '#123456'");
  put('shared-modules.json', JSON.stringify({ reactcommon: ['common'] }));
  assert.equal(audit(root, {}).total, 0);
  assert.deepEqual(Object.keys(audit(root, { scanLibs: true }).files), ['front/.libs/vx-public/react/common/Card.tsx']);
});
