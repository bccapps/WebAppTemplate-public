/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import type { CorsOptions, CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import * as bodyParser from 'body-parser';
import helmet from 'helmet';
import { AppException } from '../exceptions/AppException';
import { ValidateOnlyPipe } from './ValidateOnlyPipe';

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
  /**
   * Path prefixes (e.g. `/api/v1/inline-image/`) served to any origin: CORS open without credentials (the `Origin: null`
   * of a sandboxed iframe included) and `Cross-Origin-Resource-Policy: cross-origin` (helmet sets `same-origin`).
   * Reserve it for public, credential-free routes (images, tracking pixels). Default none; the other routes keep the
   * allow-list.
   */
  publicCorsPaths?: string[];
  /**
   * Per-request CORS decision for an origin that is NOT in `CLIENT_ORIGINS` (those keep exactly their behaviour, every
   * route). Receives the origin and the path and method of the request; for a preflight, the method asked by
   * `Access-Control-Request-Method`. Returns `undefined` (default: the origin is refused with `CORS_FORBIDDEN`) or `false`
   * (refused), `true` (allowed, with credentials) or `{ credentials }` (allowed, cookies on or off). Example: a browser
   * extension origin allowed, with cookies, on its own routes only. Not consulted without an `Origin` header; the
   * `publicCorsPaths` prefixes take precedence. Default: none.
   */
  corsOriginPolicy?: CorsOriginPolicy;
}

/** Request facts handed to {@link HttpAppOptions.corsOriginPolicy}. */
export interface CorsPolicyRequest {
  /** Path without the query string. */
  path: string;
  /** HTTP method; the requested one for a preflight. */
  method: string;
}

export type CorsOriginPolicy = (origin: string, req: CorsPolicyRequest) => boolean | { credentials: boolean } | undefined;

/** Subset of the `ValidationPipe` options exposed by {@link HttpAppOptions.validation}. */
export interface ValidationOptions {
  whitelist?: boolean;
  transform?: boolean;
  forbidNonWhitelisted?: boolean;
  /**
   * Validate only (`ValidateOnlyPipe`): class-validator DTOs are checked (400), the handler receives the request value
   * unchanged; `whitelist`/`transform`/`forbidNonWhitelisted` are then ignored. For an app whose interceptors write
   * `uid`/`user` into the body and whose DTOs are not all decorated. Default `false` (stock `ValidationPipe`).
   */
  validateOnly?: boolean;
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
  publicCorsPaths: string[];
  corsOriginPolicy?: CorsOriginPolicy;
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
    publicCorsPaths: (options.publicCorsPaths ?? []).map((p) => p.trim()).filter(Boolean),
    corsOriginPolicy: options.corsOriginPolicy,
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

/** CORS answer of the public paths: any origin (an opaque `null` one included), no credentials, `Content-Type` only. */
const PUBLIC_CORS: CorsOptions = { origin: true, credentials: false, allowedHeaders: ['Content-Type'] };

type PathRequest = { path?: string; url?: string };

function requestPath(req: PathRequest): string {
  return req.path ?? (req.url ?? '').split('?')[0];
}

/** Whether `path` starts with one of the public prefixes. */
export function isPublicCorsPath(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

type CorsRequest = PathRequest & { method?: string; headers?: Record<string, string | string[] | undefined> };

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** CORS options of one request: the policy's verdict for a foreign origin, `base` (allow-list) otherwise. */
function policyOptions(base: CorsOptions, allowedOrigins: readonly string[], policy: CorsOriginPolicy, req: CorsRequest): CorsOptions {
  const origin = headerValue(req.headers?.origin);
  if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return base;
  const method = (req.method === 'OPTIONS' ? headerValue(req.headers?.['access-control-request-method']) : undefined) ?? req.method ?? 'GET';
  const verdict = policy(origin, { path: requestPath(req), method: method.toUpperCase() });
  if (!verdict) return base;
  return { ...base, origin: true, credentials: verdict === true ? true : verdict.credentials };
}

/** CORS configuration: the open policy on the public paths, the origin policy for foreign origins, `base` (the allow-list) elsewhere. */
function corsOptions(
  base: CorsOptions,
  publicPaths: readonly string[],
  allowedOrigins: readonly string[],
  policy: CorsOriginPolicy | undefined
): CorsOptions | CorsOptionsDelegate<CorsRequest> {
  if (publicPaths.length === 0 && !policy) return base;
  return (req, callback) => {
    if (publicPaths.length > 0 && isPublicCorsPath(requestPath(req), publicPaths)) return callback(null, PUBLIC_CORS);
    return callback(null, policy ? policyOptions(base, allowedOrigins, policy, req) : base);
  };
}

/** Sets `Cross-Origin-Resource-Policy: cross-origin` on the public paths (runs after helmet, which sets `same-origin`). */
function publicResourcePolicy(publicPaths: readonly string[]) {
  return (req: PathRequest, res: { setHeader: (name: string, value: string) => void }, next: Next): void => {
    if (isPublicCorsPath(requestPath(req), publicPaths)) res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
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

/** The global pipe for resolved validation options: `ValidateOnlyPipe` in `validateOnly` mode, else the stock pipe. */
export function createGlobalValidationPipe(options: ValidationOptions): ValidationPipe {
  if (options.validateOnly) return new ValidateOnlyPipe();
  const { validateOnly: _validateOnly, ...pipeOptions } = options;
  return new ValidationPipe(pipeOptions);
}

/**
 * Applies the shared HTTP hardening to a Nest application: proxy trust, security headers, CORS,
 * body limits with raw-body capture, and the global validation pipe (`validation: false` skips it).
 * `publicCorsPaths` opens CORS and the cross-origin resource policy on those path prefixes only; `corsOriginPolicy`
 * decides per request for origins outside `CLIENT_ORIGINS`.
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
  if (resolved.publicCorsPaths.length > 0) app.use(publicResourcePolicy(resolved.publicCorsPaths));
  const cors: CorsOptions = {
    origin: corsOrigin(resolved.allowedOrigins),
    credentials: !wildcard,
    allowedHeaders: resolved.allowedHeaders,
    exposedHeaders: ['x-crypt-encrypted', 'x-crypt-version', 'x-crypt-session'],
  };
  app.enableCors(corsOptions(cors, resolved.publicCorsPaths, resolved.allowedOrigins, resolved.corsOriginPolicy) as CorsOptions);
  app.use(rawBodyMiddleware(resolved.rawBodyPaths, resolved.rawBodyLimit));
  app.use(bodyParser.json({ limit: resolved.jsonLimit }));
  app.use(bodyParser.urlencoded({ limit: resolved.jsonLimit, extended: true }));
  if (resolved.validation) app.useGlobalPipes(createGlobalValidationPipe(resolved.validation));
  return resolved;
}
