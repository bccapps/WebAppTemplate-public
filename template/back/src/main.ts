/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import 'reflect-metadata';
import { installFileLogging } from './fileLogger';
import { AppModule } from './modules/app/AppModule';
import { ProwlService } from 'src/modules_shared/common/services/ProwlService';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const compression = require('compression');
import * as http from 'http';
import * as https from 'https';
import { ConfigurationService } from 'src/modules_shared/common/services/ConfigurationService';
import { configureHttpApp, resolveListenHost } from 'src/modules_shared/common/bootstrap';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CacheableLookup = require('cacheable-lookup').default;

// Cache DNS lookups globally for all outgoing HTTP(S) requests.
// Node.js does not cache DNS responses natively — under load (many concurrent
// external API calls) this causes EAI_AGAIN errors on the system resolver.
// CacheableLookup honours TTLs and installs itself on the default agents.
const dnsCache = new CacheableLookup();
dnsCache.install(http.globalAgent);
dnsCache.install(https.globalAgent);

async function bootstrap() {
  // Timestamp every console line and tee it to <LOG_DIR>/back-<day>.log (LOG_TO_FILE=false disables the file).
  installFileLogging();

  console.log(
    'Connecting to DB provider : ' +
      process.env.DBFRONT_HOST +
      ':' +
      process.env.DBFRONT_PORT
  );

  const app = await NestFactory.create(AppModule);

  // Trust proxy, helmet, CORS (CLIENT_ORIGINS, "*" refused in production), body limits with rawBody capture
  // (RAW_BODY_PATHS) and the global ValidationPipe. Must run before app.init() so the middlewares sit ahead of
  // the router (a CORS preflight would otherwise 404).
  const { allowedOrigins } = configureHttpApp(app);
  console.log('Client origins: ' + allowedOrigins.join(','));

  // Bootstrap lifecycle hooks (OnApplicationBootstrap) — seeds config to DB
  await app.init();
  const configurationService = app.get(ConfigurationService);
  const gzipThreshold = Number(configurationService.get('common_gzip_threshold') ?? 1024);
  app.use(compression({ threshold: gzipThreshold }));
  console.log(`Gzip compression enabled (threshold: ${gzipThreshold} bytes)`);

  // configuration swagger
  const config = new DocumentBuilder()
    .setTitle('{{SITE_NAME}} API')
    .setDescription('{{SITE_NAME}} API description')
    .setVersion('1.0')
    .addTag('{{PROJECT_NAME}}')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  try {
    const host = resolveListenHost();
    await app.listen(process.env.NODE_PORT, host);
    console.log(`Listening on ${host}:${process.env.NODE_PORT}`);
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
bootstrap().catch((err) => {
  console.error('[Bootstrap] Fatal error, exiting', err);
  process.exit(1);
});
