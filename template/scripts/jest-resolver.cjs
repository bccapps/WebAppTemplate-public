/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Jest resolver for the vx-public / vx-private split. A private module imports a public one
 * with a relative path (`../../common/...`, valid through the `src/modules_shared` links), but
 * jest runs the private specs from their REAL location (`.libs/vx-private/<kind>/<m>`), where
 * `common` is not a sibling. When a relative import fails from there, retry in vx-public.
 */
const path = require('path');

const PRIVATE = `${path.sep}.libs${path.sep}vx-private${path.sep}`;
const PUBLIC = `${path.sep}.libs${path.sep}vx-public${path.sep}`;

module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (error) {
    if (request.startsWith('.') && options.basedir.includes(PRIVATE)) {
      const absolute = path.resolve(options.basedir, request).replace(PRIVATE, PUBLIC);
      return options.defaultResolver(absolute, options);
    }
    throw error;
  }
};
