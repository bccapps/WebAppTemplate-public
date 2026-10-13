/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const compression = require('compression') as (options: { threshold: number }) => RequestHandler;

export const DEFAULT_GZIP_THRESHOLD = 1024;

/**
 * Gzip middleware to register BEFORE `app.init()` (a middleware added afterwards sits behind Nest's 404 handler
 * and never runs). The threshold often lives in the database (`common_gzip_threshold`), which is only readable
 * once `init()` has seeded it: `getThreshold` is therefore called lazily, on the first request, and the resulting
 * `compression` instance is cached. An invalid or failing lookup falls back to `DEFAULT_GZIP_THRESHOLD`.
 */
export function lazyCompression(getThreshold: () => number | undefined): RequestHandler {
  let handler: RequestHandler | undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!handler) {
      let threshold: number | undefined;
      try {
        threshold = getThreshold();
      } catch {
        threshold = undefined;
      }
      handler = compression({ threshold: Number.isFinite(threshold) ? (threshold as number) : DEFAULT_GZIP_THRESHOLD });
    }
    handler(req, res, next);
  };
}
