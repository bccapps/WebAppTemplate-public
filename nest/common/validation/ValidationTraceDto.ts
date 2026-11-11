/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CHECK_NAME_MAX_LENGTH, CHECK_NAME_PATTERN } from './traceLine';
import { VALIDATION_OUTCOMES, ValidationOutcome } from './validationTrace';

/** Body of `POST /api/v1/validation/trace[/public]`: one trace emitted by the front. */
export class ValidationTraceDto {
  /** Trace name, declared by a check with `"sources": ["front"]` in a module's `validation/checks.json`. */
  @IsString()
  @MaxLength(CHECK_NAME_MAX_LENGTH)
  @Matches(CHECK_NAME_PATTERN)
  check!: string;

  @IsIn(VALIDATION_OUTCOMES)
  outcome!: ValidationOutcome;

  /** Simple values only; sanitized like any back trace (never a secret, a token or raw personal data). */
  @IsOptional()
  @IsObject()
  fields?: Record<string, unknown>;
}
