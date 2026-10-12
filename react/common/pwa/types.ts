/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export type PwaIcon = {
  src: string
  sizes: string
  type?: string
  purpose?: 'any' | 'maskable' | 'any maskable'
}

/**
 * App-level PWA descriptor — fill this in each app's `src/pwa/config.ts`
 * then pass it to `VitePWA({ manifest: config })` in `vite.config.ts`.
 */
export type PwaConfig = {
  name: string
  shortName: string
  description?: string
  themeColor: string
  backgroundColor: string
  startUrl?: string
  display?: 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser'
  orientation?: 'any' | 'portrait' | 'landscape'
  icons: PwaIcon[]
  /** Path to the apple-touch-icon (180×180 opaque PNG). */
  appleTouchIcon?: string
  appleStatusBarStyle?: 'default' | 'black' | 'black-translucent'
}
