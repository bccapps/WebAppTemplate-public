/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import 'reflect-metadata';
import { installFileLogging } from './fileLogger';
import { AppModule } from './modules/app/AppModule';
import { startApp } from 'src/modules_shared/common/bootstrap';

// Every common startup step (DNS cache, HTTP hardening, gzip, Swagger, front, listen, shutdown with the desktop shell, process
// error reporting) lives in `startApp` (modules_shared/common/bootstrap/startApp.ts): this file only holds what is specific to the
// project. Options: `http` (configureHttpApp), `early` (middlewares before everything), `beforeInit` (project middleware/route).
startApp({
  appModule: AppModule,
  swagger: { title: '{{SITE_NAME}} API', tag: '{{PROJECT_NAME}}' },
  // Timestamp every console line and tee it to <LOG_DIR>/back-<day>.log (LOG_TO_FILE=false disables the file).
  beforeCreate: installFileLogging,
});
