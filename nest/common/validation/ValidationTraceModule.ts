/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { DynamicModule, Module } from '@nestjs/common';
import { VALIDATION_CHECK_ROOTS, ValidationCheckRegistry, defaultCheckRoots } from './ValidationCheckRegistry';
import { ValidationTraceController } from './ValidationTraceController';
import { ValidationTraceService } from './ValidationTraceService';
import { isValidationTraceEnabled } from './validationTrace';

export interface ValidationTraceModuleOptions {
  /** Module folders scanned for `validation/checks.json` (default `src/modules_shared` and `src/modules` of the cwd). */
  checkRoots?: string[];
}

/**
 * Validation by observation (`nest/common/README.md`, « Validation par observation »). Imported once by `CommonModule`;
 * the front relay controller is registered only when traces are active when the module is defined.
 */
@Module({})
export class ValidationTraceModule {
  static register(options: ValidationTraceModuleOptions = {}): DynamicModule {
    return {
      module: ValidationTraceModule,
      controllers: isValidationTraceEnabled() ? [ValidationTraceController] : [],
      providers: [
        ValidationTraceService,
        ValidationCheckRegistry,
        { provide: VALIDATION_CHECK_ROOTS, useValue: options.checkRoots ?? defaultCheckRoots() },
      ],
      exports: [ValidationTraceService],
    };
  }
}
