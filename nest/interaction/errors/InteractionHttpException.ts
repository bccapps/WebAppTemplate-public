/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { CallHandler, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable, catchError, throwError } from 'rxjs';
import { AppException } from '../../common/exceptions/AppException';
import { INTERACTION_ERRORS, InteractionError, type InteractionErrorDetails } from './InteractionError';

/**
 * An `InteractionError` as an HTTP error: the common `AppExceptionFilter` writes `{ code, message, statusCode, details? }`
 * (it copies the non-`message` keys of `getResponse()` into `details`).
 */
export class InteractionHttpException extends AppException {
  constructor(
    code: string,
    message: string,
    status: number,
    private readonly detailsBody?: InteractionErrorDetails,
  ) {
    super(code, message, status);
  }

  override getResponse(): string | object {
    if (!this.detailsBody || Object.keys(this.detailsBody).length === 0) return this.message;
    return { ...this.detailsBody, message: this.message };
  }

  static from(error: InteractionError): InteractionHttpException {
    const spec = INTERACTION_ERRORS[error.code];
    return new InteractionHttpException(error.code, spec.message, spec.status, error.details);
  }
}

/**
 * Routes of the module: an `InteractionError` becomes its HTTP form; `RATE_LIMITED` also sets `Retry-After`. Anything
 * else that is not already an HTTP error (a TypeORM `QueryFailedError` carrying the SQL and its parameters, a driver or
 * programming error) is the module's boundary (review F6): logged by its class / code only and answered `500 INTERNAL`,
 * so neither a database message nor a parameter (an endpoint, a key) reaches the client or the exception filter's log.
 */
@Injectable()
export class InteractionErrorInterceptor implements NestInterceptor {
  private readonly logger = new Logger('InteractionHttp');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof HttpException) return throwError(() => error);
        if (!(error instanceof InteractionError)) {
          this.logger.warn(`route failed (${safeErrorCode(error)})`);
          return throwError(() => InteractionHttpException.from(new InteractionError('INTERNAL')));
        }
        if (error.code === 'RATE_LIMITED' && error.retryAfterSeconds) {
          const res = context.switchToHttp().getResponse<Response>();
          if (res && typeof res.setHeader === 'function' && !res.headersSent) res.setHeader('Retry-After', String(Math.ceil(error.retryAfterSeconds)));
        }
        return throwError(() => InteractionHttpException.from(error));
      }),
    );
  }
}

/** The class name of an error, and its driver code when it has a short one (`23505`, `SQLITE_CONSTRAINT`): never a message. */
export function safeErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'error';
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? `${name}:${code}` : name;
}
