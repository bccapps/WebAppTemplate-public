/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { INestApplication, Type } from '@nestjs/common';
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
  /** Swagger document (served on /api only when `resolveSwaggerEnabled()`). `description` defaults to `<title> description`. */
  swagger: { title: string; tag: string; description?: string };
  /** Options of `configureHttpApp` (body limit, validation, extra CORS headers, public CORS paths...). */
  http?: HttpAppOptions;
  /** Middlewares installed BEFORE everything else (helmet, CORS and body parsing included): URL rewriting, for instance. */
  early?: RequestHandler[];
  /** Runs first, before the app is created: file logging, extra console banner. Replaces nothing of the common steps. */
  beforeCreate?: () => void;
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
  options.beforeCreate?.();
  logDatabase();

  const app = await NestFactory.create(options.appModule);

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
  if (resolveSwaggerEnabled()) {
    const { title, tag, description } = options.swagger;
    const config = new DocumentBuilder().setTitle(title).setDescription(description ?? `${title} description`).setVersion('1.0').addTag(tag).build();
    SwaggerModule.setup('api', app, SwaggerModule.createDocument(app, config));
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

  try {
    const host = resolveListenHost();
    await app.listen(process.env.NODE_PORT, host);
    console.log(`Listening on ${host}:${process.env.NODE_PORT}`);
    // Desktop shell only (DESKTOP_PARENT_PID): exit if the shell dies without stopping us.
    exitWhenParentGone();
  } catch (err) {
    console.error('FATAL: app.listen() failed:', err);
    process.exit(1);
  }

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
