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
const compression = require('compression') as {
  (options: { threshold: number; filter: (req: Request, res: Response) => boolean }): RequestHandler;
  filter: (req: Request, res: Response) => boolean;
};

export const DEFAULT_GZIP_THRESHOLD = 1024;

/**
 * Whether a response must never go through `compression`: a Server-Sent Events stream. The compressor holds
 * every write in its buffer until it fills or the response ends (no flush after each write), so a streamed
 * LLM answer, its keep-alive comments included, reaches a client that sends `Accept-Encoding` (axios does) in
 * one burst at the very end, and that client's idle timeout fires on a perfectly healthy stream.
 * Read when the headers are sent, so the handler's `Content-Type` is already set.
 */
export function isEventStream(res: Response): boolean {
  return String(res.getHeader('Content-Type') ?? '').toLowerCase().startsWith('text/event-stream');
}

/** `compression`'s own decision (type, `Cache-Control: no-transform`, `x-no-compression`…), minus event streams. */
export function shouldCompress(req: Request, res: Response): boolean {
  return !isEventStream(res) && compression.filter(req, res);
}

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
      handler = compression({ threshold: Number.isFinite(threshold) ? (threshold as number) : DEFAULT_GZIP_THRESHOLD, filter: shouldCompress });
    }
    handler(req, res, next);
  };
}
