/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Post, UseInterceptors } from '@nestjs/common';
import { ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../decorators/Public';
import { RejectApiTokenInterceptor } from '../interceptors/RejectApiTokenInterceptor';
import { TRACE_LIMITS } from './traceSanitizer';
import { ValidationCheckRegistry } from './ValidationCheckRegistry';
import { ValidationTraceDto } from './ValidationTraceDto';
import { ValidationTraceService } from './ValidationTraceService';

/** Budget of the session route (counted per user, else per IP, by the global limiter). */
export const VALIDATION_TRACE_THROTTLE = { limit: 120, ttl: 60_000 };
/** Budget of the unauthenticated route (pre-login checks only). */
export const VALIDATION_TRACE_PUBLIC_THROTTLE = { limit: 30, ttl: 60_000 };
/** Largest `fields` object accepted from the front, serialized. */
export const MAX_FRONT_FIELDS_BYTES = 2048;

function assertSmallPlainObject(fields: unknown): Record<string, unknown> {
  if (fields === undefined) return {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new BadRequestException('Invalid trace fields');
  const keys = Object.keys(fields);
  if (keys.length > TRACE_LIMITS.maxFields || Buffer.byteLength(JSON.stringify(fields)) > MAX_FRONT_FIELDS_BYTES) {
    throw new BadRequestException('Trace fields too large');
  }
  return fields as Record<string, unknown>;
}

/**
 * Relay of the front's validation traces. Registered only when traces are active (`APP_ENV` dev/preprod): absent in
 * production (404), and the handlers answer 404 again if traces are off at runtime. Only the trace names declared with
 * `"sources": ["front"]` in a `validation/checks.json` are accepted; the unauthenticated route only those also marked
 * `"preLogin": true`. Fields are sanitized like a back trace; no body is ever logged.
 */
@ApiTags('validation')
@Controller('api/v1/validation')
export class ValidationTraceController {
  constructor(
    private readonly traces: ValidationTraceService,
    private readonly registry: ValidationCheckRegistry,
  ) {}

  @ApiNoContentResponse({ description: 'Trace recorded (dev/preprod only)' })
  @Post('trace')
  @HttpCode(204)
  @UseInterceptors(RejectApiTokenInterceptor)
  @Throttle({ default: VALIDATION_TRACE_THROTTLE })
  trace(@Body() body: ValidationTraceDto): void {
    this.relay(body, false);
  }

  @ApiNoContentResponse({ description: 'Pre-login trace recorded (dev/preprod only)' })
  @Public()
  @Post('trace/public')
  @HttpCode(204)
  @Throttle({ default: VALIDATION_TRACE_PUBLIC_THROTTLE })
  tracePublic(@Body() body: ValidationTraceDto): void {
    this.relay(body, true);
  }

  private relay(body: ValidationTraceDto, preLogin: boolean): void {
    if (!this.traces.enabled) throw new NotFoundException();
    const rule = this.registry.frontRule(body.check);
    if (!rule || (preLogin && !rule.preLogin)) throw new BadRequestException('Unknown validation check');
    this.traces.relayFront(body.check, body.outcome, assertSmallPlainObject(body.fields));
  }
}
