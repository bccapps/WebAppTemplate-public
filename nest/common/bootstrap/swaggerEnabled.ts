/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Whether Swagger (`/api`) must be served. `SWAGGER_ENABLED=true|false` decides; otherwise it is served outside
 * production only (`NODE_ENV !== 'production'`), so the API documentation is never public by accident.
 */
export function resolveSwaggerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.SWAGGER_ENABLED?.trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return env.NODE_ENV !== 'production';
}
