/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * `VITE_APP_ENV`'s prod value is the string `'production'` (`front/.env`) — NOT `'prod'`, which
 * is the backend's own `APP_ENV` prod value (`back/.env`, see `CrossEnvDbConnection.ts`'s
 * `assertProductionEnvironment`). The two are deliberately different strings on two different
 * variables; do not conflate them.
 */
export function isProductionEnvironment(): boolean {
  return (import.meta.env.VITE_APP_ENV as string | undefined) === 'production';
}

/** Raw `VITE_APP_ENV` value for display (e.g. in an admin-facing "prod only" explanation) — same value `EnvBadge.tsx` shows. */
export function currentEnvironmentLabel(): string {
  return (import.meta.env.VITE_APP_ENV as string | undefined) || 'inconnu';
}
