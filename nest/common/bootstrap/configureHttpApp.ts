/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import * as bodyParser from 'body-parser';
import helmet from 'helmet';
import { AppException } from '../exceptions/AppException';

/** Options of {@link configureHttpApp}. Every field falls back to the environment, then to a safe default. */
export interface HttpAppOptions {
  /** Comma-separated CORS allow-list. Env `CLIENT_ORIGINS`, else `http://localhost:<FRONT_PORT>`. */
  clientOrigins?: string;
  /** Production mode (refuses `*` origins, trusts one proxy hop). Env `NODE_ENV === 'production'`. */
  production?: boolean;
  /** Express `trust proxy` setting. Env `TRUST_PROXY` (`true`, `false`, a hop count or a subnet name); default 1 in production, off otherwise. */
  trustProxy?: boolean | number | string;
  /** Path fragments whose JSON body is also kept as `req.rawBody`. Env `RAW_BODY_PATHS` (comma-separated), default `/webhook`. */
  rawBodyPaths?: string[];
  /** Body size limit of every other route. Default `5mb` (anti-DoS). */
  jsonLimit?: string;
  /** Body size limit of the raw-body routes. Default `50mb`. */
  rawBodyLimit?: string;
  /** Request headers allowed by CORS in addition to the built-in ones (e.g. `x-company-id`). Default none. */
  extraCorsHeaders?: string[];
  /**
   * Global `ValidationPipe`. Default `{ whitelist: true, transform: true }`; each field given overrides its default.
   * `false` registers no global pipe (the app validates by itself, or a whitelist would strip fields it relies on).
   */
  validation?: false | ValidationOptions;
}

/** Subset of the `ValidationPipe` options exposed by {@link HttpAppOptions.validation}. */
export interface ValidationOptions {
  whitelist?: boolean;
  transform?: boolean;
  forbidNonWhitelisted?: boolean;
}

export type HttpAppEnv = Record<string, string | undefined>;

export interface ResolvedHttpAppOptions {
  allowedOrigins: string[];
  production: boolean;
  trustProxy: boolean | number | string;
  rawBodyPaths: string[];
  jsonLimit: string;
  rawBodyLimit: string;
  allowedHeaders: string[];
  /** Options of the global validation pipe, `false` when none is registered. */
  validation: false | ValidationOptions;
}

const BASE_CORS_HEADERS = ['Content-Type', 'Authorization', 'x-crypt-session', 'x-crypt-accept-encoding'];
const DEFAULT_VALIDATION: ValidationOptions = { whitelist: true, transform: true };
const DEFAULT_RAW_BODY_PATHS = ['/webhook'];

/** Splits a comma-separated list, trimming blanks and dropping empty entries. */
export function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parses `TRUST_PROXY`: `true`/`false`, an integer hop count, or any other string (e.g. `loopback`). */
export function parseTrustProxy(value: string | undefined, production: boolean): boolean | number | string {
  const raw = value?.trim();
  if (!raw) return production ? 1 : false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/** Throws when `*` is configured in production: credentialed CORS must target explicit front origins. */
export function assertSafeOrigins(allowedOrigins: string[], production: boolean): void {
  if (production && allowedOrigins.includes('*')) {
    throw new Error(
      '[SECURITY] CORS wildcard "*" is not allowed in production. ' +
        'Set CLIENT_ORIGINS to your explicit frontend domain(s) and restart.'
    );
  }
}

/** Merges explicit options, environment and defaults. Throws on an unsafe combination. */
export function resolveHttpAppOptions(options: HttpAppOptions = {}, env: HttpAppEnv = process.env): ResolvedHttpAppOptions {
  const production = options.production ?? env.NODE_ENV === 'production';
  const allowedOrigins = parseList(options.clientOrigins ?? env.CLIENT_ORIGINS ?? `http://localhost:${env.FRONT_PORT}`);
  assertSafeOrigins(allowedOrigins, production);
  const envPaths = parseList(env.RAW_BODY_PATHS);
  return {
    allowedOrigins,
    production,
    trustProxy: options.trustProxy ?? parseTrustProxy(env.TRUST_PROXY, production),
    rawBodyPaths: options.rawBodyPaths ?? (envPaths.length > 0 ? envPaths : DEFAULT_RAW_BODY_PATHS),
    jsonLimit: options.jsonLimit ?? '5mb',
    rawBodyLimit: options.rawBodyLimit ?? '50mb',
    allowedHeaders: [...new Set([...BASE_CORS_HEADERS, ...(options.extraCorsHeaders ?? []).map((h) => h.trim()).filter(Boolean)])],
    validation: options.validation === false ? false : { ...DEFAULT_VALIDATION, ...options.validation },
  };
}

/** Listen host: env `HOST`, default `0.0.0.0`. */
export function resolveListenHost(env: HttpAppEnv = process.env): string {
  return env.HOST?.trim() || '0.0.0.0';
}

type ExpressLike = { set: (key: string, value: unknown) => void };
type RawBodyRequest = { path?: string; url?: string; rawBody?: Buffer };
type Next = (err?: unknown) => void;

function corsOrigin(allowedOrigins: string[]) {
  const wildcard = allowedOrigins.includes('*');
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void => {
    if (!origin || wildcard || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(
      new AppException('CORS_FORBIDDEN', `CORS origin not allowed: ${origin}`, HttpStatus.FORBIDDEN),
      false
    );
  };
}

/** Parses the JSON body of matching routes with a larger limit and keeps the exact bytes in `req.rawBody` (signature checks). */
function rawBodyMiddleware(paths: string[], limit: string) {
  const parse = bodyParser.json({
    limit,
    verify: (req: unknown, _res: unknown, buf: Buffer) => {
      (req as RawBodyRequest).rawBody = buf;
    },
  });
  return (req: RawBodyRequest, res: unknown, next: Next): void => {
    const path = req.path ?? (req.url ?? '').split('?')[0];
    if (paths.some((p) => path.includes(p))) {
      (parse as unknown as (r: unknown, s: unknown, n: Next) => void)(req, res, next);
    } else {
      next();
    }
  };
}

/**
 * Applies the shared HTTP hardening to a Nest application: proxy trust, security headers, CORS,
 * body limits with raw-body capture, and the global validation pipe (`validation: false` skips it).
 *
 * Must run BEFORE `app.init()`: the middlewares have to sit ahead of Nest's own parsers and of the router
 * (CORS preflights would otherwise 404). Throws (instead of exiting) on an unsafe configuration; `main.ts`
 * lets the rejection of `bootstrap()` exit the process.
 */
export function configureHttpApp(app: INestApplication, options: HttpAppOptions = {}): ResolvedHttpAppOptions {
  const resolved = resolveHttpAppOptions(options);
  const wildcard = resolved.allowedOrigins.includes('*');

  (app.getHttpAdapter().getInstance() as ExpressLike).set('trust proxy', resolved.trustProxy);
  // CSP is off on purpose: the API serves JSON and Swagger UI; the front sets its own CSP (nginx / hosting headers).
  app.use(helmet({ contentSecurityPolicy: false }));
  app.enableCors({
    origin: corsOrigin(resolved.allowedOrigins),
    credentials: !wildcard,
    allowedHeaders: resolved.allowedHeaders,
    exposedHeaders: ['x-crypt-encrypted', 'x-crypt-version', 'x-crypt-session'],
  });
  app.use(rawBodyMiddleware(resolved.rawBodyPaths, resolved.rawBodyLimit));
  app.use(bodyParser.json({ limit: resolved.jsonLimit }));
  app.use(bodyParser.urlencoded({ limit: resolved.jsonLimit, extended: true }));
  if (resolved.validation) app.useGlobalPipes(new ValidationPipe(resolved.validation));
  return resolved;
}
