/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import {
  LazyTraceFields,
  ValidationOutcome,
  flushValidationTrace,
  isValidationTraceEnabled,
  recordValidationTrace,
  vtrace,
} from './validationTrace';

/**
 * Injectable face of {@link vtrace} (same switch, same sanitizing, same files). Code outside dependency injection calls
 * `vtrace` directly. Inert unless `APP_ENV` is `dev` or `preprod`.
 */
@Injectable()
export class ValidationTraceService implements OnApplicationShutdown {
  /** Whether traces are active in this process. */
  get enabled(): boolean {
    return isValidationTraceEnabled();
  }

  /** Validation trace at a decision or control point: see {@link vtrace}. */
  trace(check: string, outcome: ValidationOutcome, fields?: LazyTraceFields): void {
    vtrace(check, outcome, fields);
  }

  /**
   * Relay of a trace sent by the front (`ValidationTraceController` only): recorded with `source: 'front'`, the fields the
   * front checks declare only, sampled per client (`client`: user id or IP, kept in memory as a fingerprint).
   */
  relayFront(check: string, outcome: ValidationOutcome, fields: Record<string, unknown>, client: string): void {
    if (!this.enabled) return;
    recordValidationTrace(check, outcome, fields, { source: 'front', client });
  }

  onApplicationShutdown(): void {
    flushValidationTrace();
  }
}
