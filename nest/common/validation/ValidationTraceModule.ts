/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { DynamicModule, Module } from '@nestjs/common';
import { ValidationCheckRegistry } from './ValidationCheckRegistry';
import { ValidationTraceController } from './ValidationTraceController';
import { ValidationTraceService } from './ValidationTraceService';
import { isValidationTraceEnabled } from './validationTrace';

/**
 * Validation by observation (`nest/common/README.md`, « Validation par observation »). Imported once by `CommonModule`
 * (which re-exports it); the front relay controller is registered only when traces are active when the module is
 * defined. Tests set the environment and the `checks.json` folders with `configureValidationTrace` first.
 */
@Module({})
export class ValidationTraceModule {
  static register(): DynamicModule {
    return {
      module: ValidationTraceModule,
      controllers: isValidationTraceEnabled() ? [ValidationTraceController] : [],
      providers: [ValidationTraceService, ValidationCheckRegistry],
      exports: [ValidationTraceService],
    };
  }
}
