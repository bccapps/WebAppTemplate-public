/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// add-pwa.mjs: PWA option added to an existing project. The fixture is a project created WITHOUT the PWA (the template files
// rendered with the option off), so the patches are checked against the real shapes, and against what create-project produces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, parseArgs } from './add-pwa.mjs';
import { findExistingServiceWorkers, patchHeaders, patchIndexHtml, patchPackageLocal, patchViteConfig, renderPwaFile } from './lib/pwa-install.mjs';
import { PWA_DEV_DEPENDENCIES, renderPwaTemplate } from './lib/project-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(HERE, '..');
const pwa = { enabled: true, name: 'Demo', shortName: 'Demo', themeColor: '#102030', backgroundColor: '#fafafa' };
const read = (...p) => readFileSync(path.join(...p), 'utf8');
const quiet = async (fn) => {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, warn, error }); }
};

function fixture({ withProjectConfig = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'add-pwa-'));
  const front = path.join(root, 'front');
  mkdirSync(path.join(front, 'public'), { recursive: true });
  mkdirSync(path.join(front, 'src'), { recursive: true });
  const off = { ...pwa, enabled: false };
  for (const rel of ['front/index.html', 'front/vite.config.ts', 'front/public/_headers', 'front/public/favicon.svg']) {
    writeFileSync(path.join(root, rel), renderPwaTemplate(read(TEMPLATE, rel).replaceAll('{{SITE_NAME}}', 'Demo App'), off));
  }
  writeFileSync(path.join(front, 'package.local.json'), JSON.stringify({ name: 'demo-front', scripts: { build: 'vite build' } }, null, 2));
  if (withProjectConfig) writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ projectName: 'demo', siteName: 'Demo App', pwa: { enabled: false } }));
  return root;
}
const cli = (root, ...args) => main(['--root', root, '--no-install', ...args], TEMPLATE);

test('parseArgs: flags, values (also --k=v), unknown options refused', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--name', 'A', '--theme-color=#112233', '--no-icons']), { 'dry-run': true, name: 'A', 'theme-color': '#112233', 'no-icons': true });
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.throws(() => parseArgs(['--name']), /needs a value/);
});

test('--dry-run writes nothing', async () => {
  const root = fixture();
  assert.equal(await quiet(() => cli(root, '--dry-run')), 0);
  assert.equal(existsSync(path.join(root, 'front', 'pwa.plugin.ts')), false);
  assert.equal(JSON.parse(read(root, 'project.config.json')).pwa.enabled, false);
  rmSync(root, { recursive: true, force: true });
});

test('install: files, patches, package.local.json and project.config.json', async () => {
  const root = fixture();
  assert.equal(await quiet(() => cli(root, '--name', 'Demo "Pro"', '--short-name', 'Demo', '--theme-color', '#102030', '--background-color', '#fafafa')), 0);
  const front = path.join(root, 'front');
  const plugin = read(front, 'pwa.plugin.ts');
  assert.match(plugin, /name: "Demo \\"Pro\\"",/);
  assert.match(plugin, /background_color: '#fafafa'/);
  assert.match(read(front, 'pwa-assets.config.ts'), /images: \['public\/favicon\.svg'\]/);
  assert.match(read(front, 'pwa-assets.config.ts'), /background: '#fafafa'/);
  assert.match(read(front, 'src', 'sw.ts'), /denylist: \[\/\^\\\/api\\\/\/\]/);
  assert.equal(existsSync(path.join(front, 'src', 'components', 'PwaInstallButton.tsx')), true);
  assert.match(read(front, 'vite.config.ts'), /import \{ pwaPlugin \} from '\.\/pwa\.plugin'[\s\S]*extraPlugins: \[pwaPlugin\]/);
  assert.match(read(front, 'index.html'), /theme-color" content="#102030"[\s\S]*apple-mobile-web-app-title" content="Demo"/);
  assert.match(read(front, 'public', '_headers'), /^\/sw\.js\n {2}Cache-Control: no-cache/m);
  const pkg = JSON.parse(read(front, 'package.local.json'));
  assert.deepEqual(pkg.devDependencies, Object.fromEntries(Object.entries(PWA_DEV_DEPENDENCIES).sort(([a], [b]) => a.localeCompare(b))));
  assert.equal(pkg.scripts.build, 'vite build');
  assert.match(pkg.scripts['pwa:icons'], /pwa-assets-generator/);
  assert.deepEqual(JSON.parse(read(root, 'project.config.json')).pwa, { enabled: true, name: 'Demo "Pro"', shortName: 'Demo', themeColor: '#102030', backgroundColor: '#fafafa' });
  rmSync(root, { recursive: true, force: true });
});

test('the result is what create-project produces: patches are no-ops on a project created with the PWA', () => {
  const on = (rel) => renderPwaTemplate(read(TEMPLATE, rel).replaceAll('{{SITE_NAME}}', 'Demo App'), pwa);
  assert.equal(patchViteConfig(on('front/vite.config.ts')).changed, false);
  assert.equal(patchIndexHtml(on('front/index.html'), pwa).changed, false);
  assert.equal(patchHeaders(on('front/public/_headers')).changed, false);
});

test('a second run is refused, nothing is overwritten', async () => {
  const root = fixture();
  assert.equal(await quiet(() => cli(root)), 0);
  assert.equal(await quiet(() => cli(root)), 2);
  writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ projectName: 'demo', pwa: { enabled: false } }));
  const before = read(root, 'front', 'pwa.plugin.ts');
  writeFileSync(path.join(root, 'front', 'pwa.plugin.ts'), `${before}// mine\n`);
  assert.equal(await quiet(() => cli(root)), 2);
  assert.match(read(root, 'front', 'pwa.plugin.ts'), /\/\/ mine/);
  rmSync(root, { recursive: true, force: true });
});

test('an existing service worker is refused, then allowed with --allow-existing-sw', async () => {
  const root = fixture();
  writeFileSync(path.join(root, 'front', 'public', 'old-sw.js'), "self.addEventListener('push', () => {})");
  mkdirSync(path.join(root, 'front', 'src', 'lib'), { recursive: true });
  writeFileSync(path.join(root, 'front', 'src', 'lib', 'push.ts'), "navigator.serviceWorker.register('/old-sw.js')");
  assert.deepEqual(findExistingServiceWorkers(root).sort(), ['front/public/old-sw.js', 'front/src/lib/push.ts']);
  assert.equal(await quiet(() => cli(root)), 2);
  assert.equal(existsSync(path.join(root, 'front', 'pwa.plugin.ts')), false);
  assert.equal(await quiet(() => cli(root, '--allow-existing-sw')), 0);
  assert.equal(existsSync(path.join(root, 'front', 'src', 'sw.ts')), true);
  rmSync(root, { recursive: true, force: true });
});

test('a project without project.config.json: name from <title>, source image copied, no config created', async () => {
  const root = fixture({ withProjectConfig: false });
  writeFileSync(path.join(root, 'logo.png'), 'png');
  assert.equal(await quiet(() => cli(root, '--source', path.join(root, 'logo.png'))), 0);
  assert.match(read(root, 'front', 'pwa.plugin.ts'), /name: "Demo App",/);
  assert.equal(read(root, 'front', 'public', 'logo.png'), 'png');
  assert.match(read(root, 'front', 'pwa-assets.config.ts'), /images: \['public\/logo\.png'\]/);
  assert.equal(existsSync(path.join(root, 'project.config.json')), false);
  rmSync(root, { recursive: true, force: true });
});

test('invalid values are refused (exit 2)', async () => {
  const root = fixture();
  assert.equal(await quiet(() => cli(root, '--theme-color', 'blue')), 2);
  assert.equal(await quiet(() => cli(root, '--short-name', 'Thirteen char')), 2);
  assert.equal(existsSync(path.join(root, 'front', 'pwa.plugin.ts')), false);
  rmSync(root, { recursive: true, force: true });
});

test('patchViteConfig: single-line and multi-line options, unknown shapes give a manual instruction', () => {
  const single = patchViteConfig("import { createViteConfig } from './viteConfig'\nexport default createViteConfig({ configuration: C })\n");
  assert.match(single.text, /^import \{ createViteConfig \}.*\nimport \{ pwaPlugin \} from '\.\/pwa\.plugin'\n/);
  assert.match(single.text, /createViteConfig\(\{ extraPlugins: \[pwaPlugin\], configuration: C \}\)/);
  const multi = patchViteConfig("import a from 'a'\n\nexport default createViteConfig({\n  configuration: C,\n})\n");
  assert.match(multi.text, /createViteConfig\(\{\n  extraPlugins: \[pwaPlugin\],\n  configuration: C,\n\}\)/);
  assert.equal(patchViteConfig(multi.text).changed, false);
  const other = patchViteConfig('export default defineConfig({})');
  assert.equal(other.changed, false);
  assert.match(other.manual, /extraPlugins: \[pwaPlugin\]/);
  assert.match(patchViteConfig("createViteConfig({ extraPlugins: [mine] })").manual, /createViteConfig/);
});

test('patchIndexHtml: keeps the project tags, adds the missing ones only, manual without </head>', () => {
  const html = '<html>\n  <head>\n    <meta name="theme-color" content="#000000" />\n    <link rel="apple-touch-icon" href="/a.png" />\n  </head>\n</html>';
  const out = patchIndexHtml(html, pwa);
  assert.equal((out.text.match(/theme-color/g) ?? []).length, 1);
  assert.equal((out.text.match(/apple-touch-icon/g) ?? []).length, 1);
  assert.match(out.text, /apple-mobile-web-app-title" content="Demo"/);
  assert.equal(patchIndexHtml(out.text, pwa).changed, false);
  assert.match(patchIndexHtml('<html></html>', pwa).manual, /index\.html/);
});

test('patchPackageLocal: keeps declared versions and the other fields', () => {
  const { pkg, changed } = patchPackageLocal({ scripts: { dev: 'x' }, devDependencies: { 'vite-plugin-pwa': '^9.0.0', zed: '1' }, overrides: { a: '1' } });
  assert.equal(changed, true);
  assert.equal(pkg.devDependencies['vite-plugin-pwa'], '^9.0.0');
  assert.equal(pkg.devDependencies['workbox-core'], PWA_DEV_DEPENDENCIES['workbox-core']);
  assert.deepEqual(Object.keys(pkg.devDependencies), [...Object.keys(pkg.devDependencies)].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(pkg.overrides, { a: '1' });
  assert.equal(patchPackageLocal(pkg).changed, false);
});

test('renderPwaFile: the icon source is the project\'s own everywhere (config and comment)', () => {
  const out = renderPwaFile(read(TEMPLATE, 'front', 'pwa-assets.config.ts'), pwa, 'public/logo.png');
  assert.doesNotMatch(out, /favicon\.svg|\{\{/);
  assert.match(out, /images: \['public\/logo\.png'\]/);
});

test('CLI entry point: --dry-run exits 0, an unknown option exits 1', () => {
  const root = fixture();
  const ok = spawnSync('node', [path.join(HERE, 'add-pwa.mjs'), '--root', root, '--dry-run'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /PWA: "Demo App"/);
  assert.equal(spawnSync('node', [path.join(HERE, 'add-pwa.mjs'), '--bogus'], { encoding: 'utf8' }).status, 1);
  rmSync(root, { recursive: true, force: true });
});
