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
import { AppModule } from './modules/app/AppModule';
import { ProwlService } from 'src/modules_shared/common/services/ProwlService';
import * as bodyParser from 'body-parser';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const compression = require('compression');
import * as http from 'http';
import * as https from 'https';
import { ConfigurationService } from 'src/modules_shared/common/services/ConfigurationService';
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
  console.log(
    'Connecting to DB provider : ' +
      process.env.DBFRONT_HOST +
      ':' +
      process.env.DBFRONT_PORT
  );
  const clientOriginEnv = process.env.CLIENT_ORIGINS ?? 'http://localhost:' + process.env.FRONT_PORT;
  console.log('Client origins: ' + clientOriginEnv);
  const allowedOrigins = clientOriginEnv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const app = await NestFactory.create(AppModule);

  // CORS must be enabled before app.init() so the middleware is positioned
  // at the top of the Express stack and intercepts OPTIONS preflight requests
  // before they reach the router (which would 404 them).
  const isWildcard = allowedOrigins.includes('*');
  app.enableCors({
    origin: isWildcard
      ? true
      : (origin, callback) => {
          if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
          return callback(new Error(`CORS origin not allowed: ${origin}`), false);
        },
    credentials: !isWildcard,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-crypt-session', 'x-crypt-accept-encoding'],
    exposedHeaders: ['x-crypt-encrypted', 'x-crypt-version', 'x-crypt-session']
  });

  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

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
    await app.listen(process.env.NODE_PORT, '0.0.0.0');
    console.log('Listening on 0.0.0.0:' + process.env.NODE_PORT);
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
bootstrap();
