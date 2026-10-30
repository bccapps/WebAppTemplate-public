/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export * from './configureHttpApp';
export {
  allowedClientOrigins,
  recordAllowedClientOrigins,
  resetAllowedClientOrigins,
  resolveClientOrigins,
  resolveFrontRedirectUrl,
} from './clientOrigins';
export * from './ValidateOnlyPipe';
export * from './serveFrontend';
export * from './swaggerEnabled';
export * from './compressionMiddleware';
export * from './watchParentProcess';
export * from './startApp';
