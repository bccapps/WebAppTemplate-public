/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { VitePWA } from 'vite-plugin-pwa'

/**
 * Installable-app plugin, passed to createViteConfig() through `extraPlugins`.
 * Generated from the `pwa` section of project.config.json (name, short name, colors); from then on
 * this file is project-owned. Icons come from `npm run pwa:icons` (source: public/favicon.svg).
 */
export const pwaPlugin = VitePWA({
  registerType: 'autoUpdate',
  // injectManifest: the service worker is src/sw.ts (precache + SPA fallback, never /api/).
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  // Serve the manifest and the register link in dev too: otherwise /manifest.webmanifest falls
  // through to the SPA fallback (HTML) and the browser reports a syntax error.
  devOptions: { enabled: true, type: 'module' },
  manifest: {
    name: {{PWA_NAME_JSON}},
    short_name: {{PWA_SHORT_NAME_JSON}},
    theme_color: '{{PWA_THEME_COLOR}}',
    background_color: '{{PWA_BACKGROUND_COLOR}}',
    start_url: '/',
    display: 'standalone',
    orientation: 'any',
    icons: [
      { src: '/pwa-64x64.png', sizes: '64x64', type: 'image/png' },
      { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  injectManifest: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
    // Raise Workbox's 2 MiB default so a large main bundle is still precached.
    maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
  },
})
