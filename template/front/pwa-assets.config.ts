/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

/**
 * Generates the PWA icons from the source SVG (run: npm run pwa:icons). Output lands next to the
 * source, in public/: pwa-64x64.png, pwa-192x192.png, pwa-512x512.png, maskable-icon-512x512.png,
 * apple-touch-icon-180x180.png and favicon.ico. Replace public/favicon.svg with your logo first.
 */
export default defineConfig({
  preset: {
    ...minimal2023Preset,
    apple: { sizes: [180] },
  },
  images: ['public/favicon.svg'],
})
