/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { INestApplication, NestApplicationOptions, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { RequestHandler } from 'express';
import * as http from 'http';
import * as https from 'https';
import { ConfigurationService } from '../services/ConfigurationService';
import { ProwlService } from '../services/ProwlService';
import { DEFAULT_GZIP_THRESHOLD, lazyCompression } from './compressionMiddleware';
import { configureHttpApp, HttpAppOptions, resolveListenHost } from './configureHttpApp';
import { resolveFrontDir, serveFrontend } from './serveFrontend';
import { resolveSwaggerEnabled } from './swaggerEnabled';
import { exitWhenParentGone } from './watchParentProcess';

export interface StartAppOptions {
  /** Root module of the app (`AppModule`). */
  appModule: Type<unknown>;
  /**
   * Swagger document, served on /api only when enabled: `enabled` when given, else `resolveSwaggerEnabled()` (SWAGGER_ENABLED, off in
   * production by default). `description` defaults to `<title> description`; `customize` adds to the builder (API key, bearer auth...).
   */
  swagger: { title: string; tag?: string; description?: string; enabled?: boolean; customize?: (builder: DocumentBuilder) => DocumentBuilder };
  /** Options of `NestFactory.create` (custom logger or log levels). */
  nest?: NestApplicationOptions;
  /** Options of `configureHttpApp` (body limit, validation, extra CORS headers, public CORS paths...). */
  http?: HttpAppOptions;
  /** Middlewares installed BEFORE everything else (helmet, CORS and body parsing included): URL rewriting, for instance. */
  early?: RequestHandler[];
  /** Runs first, before the app is created (may be async): file logging, a schema guard. Replaces nothing of the common steps. */
  beforeCreate?: () => void | Promise<void>;
  /** Runs right after the app is created, before any middleware: shutdown hooks, Express settings, process handlers. */
  afterCreate?: (app: INestApplication) => void;
  /** Runs once the app listens (and the shell watch is armed): a project post-start step. */
  afterListen?: (app: INestApplication) => void | Promise<void>;
  /** Runs after the common middlewares and BEFORE `app.init()`: the place for a project middleware or route. */
  beforeInit?: (app: INestApplication) => void | Promise<void>;
}

/**
 * Cache DNS lookups of every outgoing HTTP(S) request. Node does not cache DNS answers: under load (many concurrent external API
 * calls) the system resolver fails with EAI_AGAIN. CacheableLookup honours TTLs and installs itself on the default agents.
 */
function installDnsCache(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const CacheableLookup = require('cacheable-lookup').default;
  const dnsCache = new CacheableLookup();
  dnsCache.install(http.globalAgent);
  dnsCache.install(https.globalAgent);
}

function logDatabase(): void {
  const engine = (process.env.DB_ENGINE ?? 'postgres').toLowerCase();
  console.log('Database: ' + (engine === 'sqlite' ? `sqlite ${process.env.DB_PATH ?? ''}` : `${engine} ${process.env.DB_HOST ?? ''}:${process.env.DB_PORT ?? ''}`));
}

async function bootstrap(options: StartAppOptions): Promise<void> {
  installDnsCache();
  await options.beforeCreate?.();
  logDatabase();

  const app = await NestFactory.create(options.appModule, options.nest ?? {});
  options.afterCreate?.(app);

  // Everything below, including the project hooks, must be registered BEFORE app.init(): Nest appends its 404 handler and exception
  // filter at the end of init(), so a middleware or route added afterwards is never reached.
  for (const middleware of options.early ?? []) app.use(middleware);

  // Trust proxy, helmet, CORS (CLIENT_ORIGINS, "*" refused in production), body limits with rawBody capture (RAW_BODY_PATHS)
  // and the global ValidationPipe.
  const { allowedOrigins } = configureHttpApp(app, options.http);
  console.log('Client origins: ' + allowedOrigins.join(','));

  // Gzip. The threshold is stored in the DB (seeded by init), so it is read lazily on the first request.
  app.use(
    lazyCompression(() => {
      const threshold = Number(app.get(ConfigurationService).get('common_gzip_threshold') ?? DEFAULT_GZIP_THRESHOLD);
      console.log(`Gzip compression enabled (threshold: ${threshold} bytes)`);
      return threshold;
    })
  );

  // Swagger on /api: SWAGGER_ENABLED=true|false, else only outside production (never public by accident).
  const { title, tag, description, enabled, customize } = options.swagger;
  if (enabled ?? resolveSwaggerEnabled()) {
    let builder = new DocumentBuilder().setTitle(title).setDescription(description ?? `${title} description`).setVersion('1.0');
    if (tag) builder = builder.addTag(tag);
    if (customize) builder = customize(builder);
    SwaggerModule.setup('api', app, SwaggerModule.createDocument(app, builder.build()));
  }

  // Optional same-origin front (SERVE_FRONT_DIR=<built front dir>, set by the desktop shell): static files, SPA fallback.
  const frontDir = resolveFrontDir();
  if (frontDir) {
    serveFrontend(app, frontDir);
    console.log('Serving front from ' + frontDir);
  }

  await options.beforeInit?.(app);

  // Bootstrap lifecycle hooks (OnApplicationBootstrap): seeds config to the DB.
  await app.init();

  const port = process.env.NODE_PORT;
  if (!port) throw new Error('NODE_PORT is not set: check your .env file.');
  try {
    const host = resolveListenHost();
    await app.listen(port, host);
    console.log(`Listening on ${host}:${port}`);
    // Desktop shell only (DESKTOP_PARENT_PID): exit if the shell dies without stopping us.
    exitWhenParentGone();
  } catch (err) {
    console.error('FATAL: app.listen() failed:', err);
    process.exit(1);
  }

  await options.afterListen?.(app);

  const prowlService = app.get(ProwlService);
  process.on('uncaughtException', (error) => {
    console.error('[Process] Uncaught exception:', error);
    prowlService.safeNotify('Uncaught Exception', error.message ?? String(error));
  });
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error('[Process] Unhandled rejection:', reason);
    prowlService.safeNotify('Unhandled Rejection', message);
  });
}

/** Starts the app with every common step in the right order; a failure at startup is logged and exits the process. */
export function startApp(options: StartAppOptions): void {
  bootstrap(options).catch((err) => {
    console.error('[Bootstrap] Fatal error, exiting', err);
    process.exit(1);
  });
}
