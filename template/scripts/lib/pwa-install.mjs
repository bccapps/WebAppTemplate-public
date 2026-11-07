/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Installs the PWA option into an EXISTING project (same result as answering « yes » to the PWA question of
 * create-project.mjs): copy of the `pwa` group of component-templates.json, then small idempotent patches of the
 * project-owned files (vite.config.ts, index.html, _headers, package.local.json). Used by add-pwa.mjs.
 *
 * Every patch is a pure function `text -> { text, changed, manual? }`: `manual` carries the instruction to show when the
 * file has a shape the patch does not recognise (nothing is then modified). Nothing existing is ever overwritten.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { PWA_DEV_DEPENDENCIES, renderPwaTemplate } from './project-engine.mjs';

/** Where the icon generator reads its image when the project has a favicon and no `--source`. */
export const DEFAULT_ICON_SOURCE = 'public/favicon.svg';

/** The `pwa` group of component-templates.json: `{ from, to }` pairs (template root / project root relative). */
export function pwaFiles(templateRoot) {
  const manifest = JSON.parse(readFileSync(path.join(templateRoot, 'component-templates.json'), 'utf8'));
  return Object.entries(manifest.pwa ?? {}).map(([from, to]) => ({ from, to }));
}

/** Files of the group, split into the ones to write and the ones already in the way (never overwritten). */
export function planPwaInstall(root, templateRoot) {
  const files = pwaFiles(templateRoot);
  return { files, conflicts: files.filter(({ to }) => existsSync(path.join(root, to))).map(({ to }) => to) };
}

/** Rendered content of one template file; the icon source of `pwa-assets.config.ts` is the project's own. */
export function renderPwaFile(text, pwa, iconSource = DEFAULT_ICON_SOURCE) {
  return renderPwaTemplate(text, pwa).replaceAll(DEFAULT_ICON_SOURCE, iconSource);
}

// ---------------------------------------------------------------------------
// Existing service workers
// ---------------------------------------------------------------------------

const SW_REGISTER = /serviceWorker\s*\.\s*register\s*\(/;
const SW_HANDLER = /addEventListener\(\s*['"](?:push|fetch|notificationclick)['"]/;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

function walkSources(dir, base, out, depth = 0) {
  if (!existsSync(dir) || depth > 8) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSources(abs, path.join(base, entry.name), out, depth + 1);
    else if (entry.isFile() && SOURCE_FILE.test(entry.name)) out.push({ abs, rel: path.join(base, entry.name) });
  }
}

/**
 * Files of `front/` that already register or implement a service worker. A scope has ONE service worker: the PWA one
 * (`src/sw.ts`, registered by vite-plugin-pwa on `/`) would replace it, so its handlers must be merged first.
 */
export function findExistingServiceWorkers(root) {
  const found = [];
  const files = [];
  walkSources(path.join(root, 'front', 'src'), path.join('front', 'src'), files);
  walkSources(path.join(root, 'front', 'public'), path.join('front', 'public'), files);
  for (const { abs, rel } of files) {
    if (rel === path.join('front', 'src', 'sw.ts')) continue;
    const text = readFileSync(abs, 'utf8');
    if (SW_REGISTER.test(text) || (rel.startsWith(path.join('front', 'public')) && SW_HANDLER.test(text))) found.push(rel);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

/** vite.config.ts: import `pwaPlugin` and pass it through `extraPlugins` of `createViteConfig({ ... })`. */
export function patchViteConfig(text) {
  if (/\bpwaPlugin\b/.test(text)) return { text, changed: false };
  const manual = "add `import { pwaPlugin } from './pwa.plugin'` and `extraPlugins: [pwaPlugin]` to the createViteConfig() options of front/vite.config.ts";
  const call = text.match(/createViteConfig\(\s*\{/);
  if (!call || /\bextraPlugins\s*:/.test(text)) return { text, changed: false, manual };
  const open = call.index + call[0].length;
  const multiline = text[open] === '\n' || text.slice(open).match(/^[ \t]*\n/);
  const insertion = multiline ? '\n  extraPlugins: [pwaPlugin],' : ' extraPlugins: [pwaPlugin],';
  let out = text.slice(0, open) + insertion + text.slice(open);
  const imports = [...out.matchAll(/^import .*$/gm)];
  const line = "import { pwaPlugin } from './pwa.plugin'";
  if (imports.length) {
    const last = imports.at(-1);
    out = out.slice(0, last.index + last[0].length) + `\n${line}` + out.slice(last.index + last[0].length);
  } else out = `${line}\n${out}`;
  return { text: out, changed: true };
}

/** index.html: the tags a PWA needs, each added only when missing (a project theme-color is kept). */
export function patchIndexHtml(text, pwa) {
  const head = text.search(/^[ \t]*<\/head>/m);
  if (head < 0) return { text, changed: false, manual: 'add the PWA <meta> tags (theme-color, apple-mobile-web-app-*, apple-touch-icon) to front/index.html' };
  const tags = [];
  const escape = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  if (!/name=["']theme-color["']/.test(text)) tags.push(`<meta name="theme-color" content="${pwa.themeColor}" />`);
  if (!/name=["']mobile-web-app-capable["']/.test(text)) tags.push('<meta name="mobile-web-app-capable" content="yes" />');
  if (!/name=["']apple-mobile-web-app-capable["']/.test(text)) tags.push('<meta name="apple-mobile-web-app-capable" content="yes" />');
  if (!/name=["']apple-mobile-web-app-title["']/.test(text)) tags.push(`<meta name="apple-mobile-web-app-title" content="${escape(pwa.shortName)}" />`);
  if (!/rel=["']apple-touch-icon["']/.test(text)) tags.push('<link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png" />');
  if (!tags.length) return { text, changed: false };
  const block = ['<!-- The manifest <link> is injected by vite-plugin-pwa (dev and build): do not hardcode it. -->', ...tags].map((t) => `    ${t}\n`).join('');
  return { text: text.slice(0, head) + block + text.slice(head), changed: true };
}

const HEADERS_BLOCK = '/sw.js\n  Cache-Control: no-cache\n\n/registerSW.js\n  Cache-Control: no-cache\n\n/manifest.webmanifest\n  Cache-Control: no-cache\n\n';

/** public/_headers (Cloudflare Pages): the service worker and the manifest are never cached. */
export function patchHeaders(text) {
  if (/^\/sw\.js\s*$/m.test(text)) return { text, changed: false };
  return { text: HEADERS_BLOCK + text, changed: true };
}

/** package.local.json: the icon script and the PWA dev dependencies, without touching what is already declared. */
export function patchPackageLocal(pkg) {
  const next = JSON.parse(JSON.stringify(pkg));
  let changed = false;
  next.scripts ??= {};
  if (!next.scripts['pwa:icons']) {
    next.scripts['pwa:icons'] = 'pwa-assets-generator --config pwa-assets.config.ts';
    changed = true;
  }
  next.devDependencies ??= {};
  for (const [name, version] of Object.entries(PWA_DEV_DEPENDENCIES)) {
    if (!(name in next.devDependencies) && !(name in (next.dependencies ?? {}))) {
      next.devDependencies[name] = version;
      changed = true;
    }
  }
  next.devDependencies = Object.fromEntries(Object.entries(next.devDependencies).sort(([a], [b]) => a.localeCompare(b)));
  return { pkg: next, changed };
}

/** `<title>` of an index.html, used as the default app name of a project that has no project.config.json. */
export function titleOf(html) {
  return html.match(/<title>([^<]*)<\/title>/i)?.[1].trim() ?? '';
}
