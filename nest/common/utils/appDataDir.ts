/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { join } from 'path';

/**
 * `APP_DATA_DIR`: root of the application's writable data (desktop shells point it at the OS data folder).
 * Default base of `SHARED_DIRECTORY` (`<dir>/shared`), `LOG_DIR` (`<dir>/logs`) and a relative `DB_PATH`.
 * Returns `undefined` when unset or blank, so every consumer keeps its previous default.
 */
export function resolveAppDataDir(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.APP_DATA_DIR?.trim() || undefined;
}

/** `<APP_DATA_DIR>/<sub>`, or `undefined` when `APP_DATA_DIR` is not set. */
export function appDataSubdir(sub: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const root = resolveAppDataDir(env);
  return root ? join(root, sub) : undefined;
}
