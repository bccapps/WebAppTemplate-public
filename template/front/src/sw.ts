/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/// <reference lib="webworker" />

// Custom service worker (vite-plugin-pwa `injectManifest` strategy). Scope, deliberately minimal:
//  - precache the static build assets: installability, fast repeat loads, offline shell;
//  - SPA navigation fallback: the installed app and deep links open, offline included;
//  - NO runtime caching of /api/*: application data always comes from the network, never from a
//    stale cache.
// It is excluded from tsconfig.app.json (the webworker lib conflicts with the DOM lib).

import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope & {
  __WB_DISABLE_DEV_LOGS?: boolean
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

// Mute Workbox's dev-runtime console chatter ("Router is responding to: ...").
self.__WB_DISABLE_DEV_LOGS = true

// `registerType: 'autoUpdate'` behaviour: activate the new service worker immediately.
self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()

// Precache the hashed build assets injected by vite-plugin-pwa.
precacheAndRoute(self.__WB_MANIFEST)

// Serve the precached index.html for page navigations. In dev, restrict to the root so the route
// does not hijack Vite's dev-server routes. API requests are excluded: they always hit the network.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    allowlist: import.meta.env.DEV ? [/^\/$/] : undefined,
    denylist: [/^\/api\//],
  }),
)
