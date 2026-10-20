#!/usr/bin/env node
/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Splices an app's own nginx `location` blocks (optional `front/nginx.locations.conf`) into the shared
 * `front/nginx.conf`, at its `# @app-locations` marker line. Run by deploy-full.sh on the staged front copy, before
 * either build path (local prebuilt or remote Dockerfile) reads nginx.conf. `${NODE_PORT}` is substituted afterwards,
 * like in the rest of the file.
 *
 * Usage: node merge-nginx-locations.mjs <nginx.conf> <nginx.locations.conf>
 * No locations file = nothing to do. A locations file but no marker (an app-owned nginx.conf without it) = exit 1.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_LOCATIONS_MARKER = /^[ \t]*# @app-locations\b.*$/m;

/** nginx.conf with the marker line replaced by the locations; throws when the marker is missing. */
export function mergeNginxLocations(nginxConf, locations) {
  if (!APP_LOCATIONS_MARKER.test(nginxConf)) {
    throw new Error('nginx.conf has no "# @app-locations" marker line: cannot add front/nginx.locations.conf');
  }
  return nginxConf.replace(APP_LOCATIONS_MARKER, () => locations.trimEnd());
}

function main([nginxFile, locationsFile]) {
  if (!nginxFile || !locationsFile) {
    console.error('usage: merge-nginx-locations.mjs <nginx.conf> <nginx.locations.conf>');
    return 2;
  }
  if (!existsSync(locationsFile) || !existsSync(nginxFile)) return 0;
  try {
    writeFileSync(nginxFile, mergeNginxLocations(readFileSync(nginxFile, 'utf8'), readFileSync(locationsFile, 'utf8')));
  } catch (error) {
    console.error(`✖ ${error.message}`);
    return 1;
  }
  console.log(`==> [LOCAL] ${locationsFile} merged into ${nginxFile}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
