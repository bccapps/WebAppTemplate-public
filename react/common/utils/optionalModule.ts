/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Resolves a module contributed by another `modules_shared` package without a static import —
 * pass the result of an `import.meta.glob('/src/modules_shared/<module>/...', { ... })` call for
 * a specific known path. Vite resolves the glob at build time and returns an empty object when
 * the target file doesn't exist in this project's checkout (e.g. an optional submodule not
 * present), so callers never take a hard compile-time dependency on the other module.
 */
export async function loadOptionalModule<T>(glob: Record<string, () => Promise<T>>): Promise<T | null> {
  const [importer] = Object.values(glob);
  return importer ? await importer() : null;
}
