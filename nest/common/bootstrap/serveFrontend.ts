/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { INestApplication } from '@nestjs/common';
import { static as serveStatic } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { existsSync } from 'fs';
import { basename, resolve } from 'path';
import type { HttpAppEnv } from './configureHttpApp';

const ASSETS_PREFIX = '/assets/';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

/** Directory of the built front: env `SERVE_FRONT_DIR` (relative paths resolve against the working directory), or `undefined` when unset. */
export function resolveFrontDir(env: HttpAppEnv = process.env): string | undefined {
  const dir = env.SERVE_FRONT_DIR?.trim();
  return dir ? resolve(dir) : undefined;
}

/** `path` is `prefix` or below `prefix/`, in any case: Express routes are case-insensitive, so `/API/v1/x` reaches the same Nest route as `/api/v1/x`. */
function isUnder(path: string, prefix: string): boolean {
  const lower = path.toLowerCase();
  return lower === prefix || lower.startsWith(`${prefix}/`);
}

/** True for `/api` (Swagger) and anything below `/api/` (the REST API lives on `/api/v1`), in any case. */
export function isApiPath(path: string): boolean {
  return isUnder(path, '/api');
}

/**
 * True for `/.well-known` and anything below `/.well-known/`, in any case (RFC 8615: discovery documents such as
 * `oauth-protected-resource` or `oauth-authorization-server`, served by Nest routes, never by the SPA).
 */
export function isWellKnownPath(path: string): boolean {
  return isUnder(path, '/.well-known');
}

/** Cache headers of static files: `index.html` must always be revalidated, hashed `/assets/*` never change. */
function setCacheHeaders(res: Response, filePath: string, urlPath: string): void {
  if (basename(filePath) === 'index.html') res.setHeader('Cache-Control', NO_CACHE);
  else if (urlPath.startsWith(ASSETS_PREFIX)) res.setHeader('Cache-Control', IMMUTABLE);
}

function staticMiddleware(dir: string): RequestHandler {
  // `index: false`: "/" is answered by the SPA fallback so that its headers are set in one place.
  return (req, res, next) => {
    const serve = serveStatic(dir, { index: false, setHeaders: (r, filePath) => setCacheHeaders(r, filePath, req.path) });
    serve(req, res, next);
  };
}

/**
 * Client-side routing: any HTML `GET` that is not the API, Swagger, a `/.well-known/` document or a missing asset gets
 * `index.html`. `req.accepts('html')` is also true for a wildcard `Accept` and for no `Accept` header, hence the explicit exclusions.
 */
function spaFallback(dir: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.path;
    if (req.method !== 'GET' || isApiPath(path) || isWellKnownPath(path) || path.startsWith(ASSETS_PREFIX) || !req.accepts('html')) return next();
    res.sendFile('index.html', { root: dir, headers: { 'Cache-Control': NO_CACHE } }, (err) => (err ? next(err) : undefined));
  };
}

/**
 * Serves a built single-page front (`dir` containing `index.html`) from the Nest application, for a
 * same-origin deployment (relative API URLs, no CORS) such as the desktop shell or a one-container install.
 *
 * - static files from `dir`; `index.html` is sent with `Cache-Control: no-cache`, `/assets/*` as immutable;
 * - SPA fallback to `index.html` for every `GET` that accepts HTML and is neither `/api`, `/api/*`, `/.well-known`,
 *   `/.well-known/*` nor `/assets/*` (any case; a `/.well-known/` path is the back's, a 404 when it has no route);
 * - a missing `/assets/*` file is a plain 404, never the index.
 *
 * Call it BEFORE `app.init()`: Nest registers its 404 and exception handlers at the end of `app.init()`, so anything
 * registered afterwards is never reached. The SPA fallback ignores `/api`, `/api/*`, `/.well-known` and `/.well-known/*`,
 * hence it never masks a Nest route nor Nest's own 404. Throws if `dir/index.html`
 * is missing, so that a wrong `SERVE_FRONT_DIR` fails at startup.
 */
export function serveFrontend(app: INestApplication, dir: string): void {
  const root = resolve(dir);
  if (!existsSync(resolve(root, 'index.html'))) {
    throw new Error(`[serveFrontend] index.html not found in SERVE_FRONT_DIR (${root})`);
  }
  app.use(staticMiddleware(root));
  app.use(spaFallback(root));
}
