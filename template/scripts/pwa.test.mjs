/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// PWA option of the wizard. No `git init` here: the dry-run plan is read through the CLI, and the
// component copy is exercised directly on a temp directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { answersFromCli, parseCli, renderPlan } from './create-project.mjs';
import {
  PWA_DEV_DEPENDENCIES, filterPwaBlocks, frontPackageLocal, loadCatalog, normalizeAnswers, renderPwaTemplate, resolvePwa, validateAnswers,
} from './lib/project-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TEMPLATE = path.join(REPO, 'template');
const base = { projectName: 'demo', siteName: 'Demo App', entityName: 'Acme', contactEmail: 'a@b.co' };
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

const dryRun = (args) => spawnSync('node', [
  path.join(HERE, 'create-project.mjs'), '--dry-run', '--yes', '--no-private', '--name', 'demo', '--site-name', 'Demo App',
  '--public-dir', REPO, '--parent-dir', tmpdir(), ...args,
], { encoding: 'utf8' });

test('CLI flags map to the pwa answers', () => {
  assert.deepEqual(answersFromCli(parseCli(['--pwa'])), { pwa: { enabled: true } });
  assert.deepEqual(answersFromCli(parseCli(['--no-pwa'])), { pwa: { enabled: false } });
  assert.deepEqual(
    answersFromCli(parseCli(['--pwa', '--pwa-name', 'Big App', '--pwa-short-name=Big', '--pwa-theme-color', '#112233', '--pwa-background-color', '#ffffff'])),
    { pwa: { enabled: true, name: 'Big App', shortName: 'Big', themeColor: '#112233', backgroundColor: '#ffffff' } },
  );
});

test('resolvePwa: defaults come from the site name, shortName is cut to 12 characters', () => {
  assert.equal(normalizeAnswers({}).pwa.enabled, false);
  assert.deepEqual(resolvePwa({ ...base, pwa: { enabled: true } }), {
    enabled: true, name: 'Demo App', shortName: 'Demo App', themeColor: '#1976d2', backgroundColor: '#ffffff',
  });
  assert.equal(resolvePwa({ ...base, siteName: 'A Very Long Site Name', pwa: { enabled: true } }).shortName, 'A Very Long');
  assert.equal(resolvePwa({ ...base, pwa: { enabled: true, name: 'Other', themeColor: '#000000' } }).themeColor, '#000000');
});

test('validation: pwa is checked only when enabled', () => {
  const catalog = loadCatalog({ public: REPO });
  const errors = (pwa) => validateAnswers({ ...base, pwa }, catalog).join(' | ');
  assert.equal(errors({ enabled: false, themeColor: 'red' }), '');
  assert.equal(errors({ enabled: true }), '');
  assert.match(errors({ enabled: true, themeColor: 'red' }), /pwa\.themeColor "red" must be a #rrggbb color/);
  assert.match(errors({ enabled: true, backgroundColor: '#fff' }), /pwa\.backgroundColor/);
  assert.match(errors({ enabled: true, shortName: 'Thirteen char' }), /longer than 12 characters/);
});

test('front/package.local.json: PWA packages and icon script only when enabled', () => {
  const off = frontPackageLocal(base);
  assert.equal(off.devDependencies, undefined);
  assert.equal(off.scripts['pwa:icons'], undefined);
  assert.equal(off.name, 'demo-front');
  const on = frontPackageLocal({ ...base, pwa: { enabled: true } });
  assert.deepEqual(on.devDependencies, PWA_DEV_DEPENDENCIES);
  assert.ok('vite-plugin-pwa' in on.devDependencies && '@vite-pwa/assets-generator' in on.devDependencies);
  assert.match(on.scripts['pwa:icons'], /pwa-assets-generator/);
  assert.equal(on.scripts.build, 'tsc -b && vite build');
});

test('filterPwaBlocks: every comment syntax, markers always removed, errors on unbalanced markers', () => {
  const text = ['a', '// {{#PWA}}', 'ts', '// {{/PWA}}', '<!-- {{#PWA}} -->', 'html', '<!-- {{/PWA}} -->', '# {{#PWA}}', 'hdr', '# {{/PWA}}',
    '  {/* {{#PWA}} */}', '  <Jsx />', '  {/* {{/PWA}} */}', 'b'].join('\n');
  assert.equal(filterPwaBlocks(text, false), 'a\nb');
  assert.equal(filterPwaBlocks(text, true), 'a\nts\nhtml\nhdr\n  <Jsx />\nb');
  assert.throws(() => filterPwaBlocks('// {{#PWA}}\nx', true), /unterminated/);
  assert.throws(() => filterPwaBlocks('// {{/PWA}}', true), /unbalanced/);
});

test('renderPwaTemplate: placeholders are escaped for TS strings and HTML attributes', () => {
  const pwa = { enabled: true, name: 'Tom\'s "App" <1>', shortName: 'Tom', themeColor: '#112233', backgroundColor: '#ffffff' };
  const out = renderPwaTemplate('name: {{PWA_NAME_JSON}}, c: \'{{PWA_THEME_COLOR}}\', h: "{{PWA_NAME_HTML}}"', pwa);
  assert.equal(out, 'name: "Tom\'s \\"App\\" <1>", c: \'#112233\', h: "Tom\'s &quot;App&quot; &lt;1&gt;"');
});

test('every {{#PWA}} marker of the template files is balanced', () => {
  for (const rel of ['front/index.html', 'front/vite.config.ts', 'front/public/_headers', 'front/src/components/Header.tsx']) {
    const text = readFileSync(path.join(TEMPLATE, rel), 'utf8');
    assert.ok(text.includes('{{#PWA}}'), `${rel} has a PWA block`);
    assert.doesNotThrow(() => filterPwaBlocks(text, true), rel);
  }
});

test('--dry-run without PWA: plan says no, no PWA file listed', () => {
  const r = dryRun([]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^PWA {13}no$/m);
  assert.doesNotMatch(r.stdout, /pwa\.plugin\.ts/);
  assert.match(r.stdout, /front\/public\/\{robots\.txt,_redirects,_headers,favicon\.svg\}/);
});

test('--dry-run with PWA: plan lists the parameters and the PWA files; a bad color is refused (exit 2)', () => {
  const r = dryRun(['--pwa', '--pwa-name', 'My App', '--pwa-theme-color', '#0a0a0a']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /PWA {13}yes \("My App" \/ "My App", theme #0a0a0a, background #ffffff/);
  assert.match(r.stdout, /front\/pwa\.plugin\.ts, front\/pwa-assets\.config\.ts, front\/src\/sw\.ts/);
  const bad = dryRun(['--pwa', '--pwa-theme-color', 'blue']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /pwa\.themeColor/);
});

test('renderPlan reads the pwa section of the answers', () => {
  const catalog = loadCatalog({ public: REPO });
  const resolved = { ids: ['common'], perStack: { nest: ['common'], react: ['common'] }, added: [] };
  const a = normalizeAnswers({ ...base, pwa: { enabled: true } });
  assert.match(renderPlan(a, resolved, catalog, '/x'), /PWA {13}yes/);
});

function applyTemplates(pwa) {
  const root = mkdtempSync(path.join(tmpdir(), 'pwa-'));
  writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ ...base, pwa }));
  const r = spawnSync('node', [path.join(HERE, 'apply-component-templates.mjs'), root, '--site-name', 'Demo App', '--entity-name', 'Acme',
    '--contact-email', 'a@b.co', '--project-name', 'demo'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return root;
}

test('apply-component-templates without PWA: public files copied, no PWA trace anywhere', () => {
  const root = applyTemplates({ enabled: false });
  const front = path.join(root, 'front');
  assert.deepEqual(readdirSync(path.join(front, 'public')).sort(), ['_headers', '_redirects', 'favicon.svg', 'robots.txt']);
  assert.equal(readFileSync(path.join(front, 'public', '_redirects'), 'utf8').trim(), '/*  /index.html  200');
  for (const f of ['pwa.plugin.ts', 'pwa-assets.config.ts', 'src/sw.ts', 'src/components/PwaInstallButton.tsx']) assert.equal(existsSync(path.join(front, f)), false, f);
  const headers = readFileSync(path.join(front, 'public', '_headers'), 'utf8');
  assert.doesNotMatch(headers, /sw\.js|manifest|\{\{/);
  assert.match(headers, /\/assets\/\*/);
  assert.doesNotMatch(readFileSync(path.join(front, 'vite.config.ts'), 'utf8'), /pwa/i);
  assert.doesNotMatch(readFileSync(path.join(front, 'index.html'), 'utf8'), /theme-color|apple-touch|\{\{#?\/?PWA/);
  assert.doesNotMatch(readFileSync(path.join(front, 'src', 'components', 'Header.tsx'), 'utf8'), /Pwa|\{\{[#/]PWA/);
  assert.match(readFileSync(path.join(front, 'src', 'main.tsx'), 'utf8'), /installPreloadErrorReload/);
  assert.match(readFileSync(path.join(front, 'index.html'), 'utf8'), /href="\/favicon\.svg"/);
  rmSync(root, { recursive: true, force: true });
});

test('apply-component-templates with PWA: plugin, service worker, button, tags and headers, values from project.config.json', () => {
  const root = applyTemplates({ enabled: true, name: 'Demo "Pro"', shortName: 'Demo', themeColor: '#102030', backgroundColor: '#fafafa' });
  const front = path.join(root, 'front');
  const plugin = readFileSync(path.join(front, 'pwa.plugin.ts'), 'utf8');
  assert.match(plugin, /name: "Demo \\"Pro\\"",/);
  assert.match(plugin, /short_name: "Demo",/);
  assert.match(plugin, /theme_color: '#102030'/);
  assert.match(plugin, /background_color: '#fafafa'/);
  assert.doesNotMatch(plugin, /\{\{/);
  assert.match(readFileSync(path.join(front, 'src', 'sw.ts'), 'utf8'), /denylist: \[\/\^\\\/api\\\/\/\]/);
  assert.match(readFileSync(path.join(front, 'vite.config.ts'), 'utf8'), /import \{ pwaPlugin \} from '\.\/pwa\.plugin'[\s\S]*extraPlugins: \[pwaPlugin\]/);
  const html = readFileSync(path.join(front, 'index.html'), 'utf8');
  assert.match(html, /<meta name="theme-color" content="#102030" \/>/);
  assert.match(html, /apple-mobile-web-app-title" content="Demo"/);
  assert.match(readFileSync(path.join(front, 'public', '_headers'), 'utf8'), /^\/sw\.js\n {2}Cache-Control: no-cache/m);
  const header = readFileSync(path.join(front, 'src', 'components', 'Header.tsx'), 'utf8');
  assert.match(header, /import \{ PwaInstallButton \} from '\.\/PwaInstallButton'/);
  assert.match(header, /<PwaInstallButton \/>/);
  assert.match(readFileSync(path.join(front, 'src', 'components', 'PwaInstallButton.tsx'), 'utf8'), /usePwaInstallPrompt/);
  assert.equal(existsSync(path.join(front, 'pwa-assets.config.ts')), true);
  rmSync(root, { recursive: true, force: true });
});

test('apply-component-templates fails loudly when a target already exists (one-shot)', () => {
  const root = applyTemplates({ enabled: false });
  mkdirSync(path.join(root, 'front'), { recursive: true });
  const again = spawnSync('node', [path.join(HERE, 'apply-component-templates.mjs'), root], { encoding: 'utf8' });
  assert.notEqual(again.status, 0);
  assert.equal(json(path.join(root, 'project.config.json')).pwa.enabled, false);
  rmSync(root, { recursive: true, force: true });
});
