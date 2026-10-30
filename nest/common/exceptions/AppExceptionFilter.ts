/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppException } from './AppException';
import { ProwlService } from '../services/ProwlService';
import { BodyParserErrorInfo, bodyParserErrorInfo, bodyParserErrorOf } from '../utils/bodyParserErrors';
import { RateLimitedLog } from '../utils/rateLimitedLog';
import { redactPath, redactUrlIn } from '../utils/redactPath';

/** Body-parser errors (client mistakes any anonymous caller can repeat) logged per category and per minute. */
export const BODY_ERROR_LOG_PER_MINUTE = 5;
/** Other 4xx lines (404 unknown route, 401 bad token, 403, 429 from the limiter…) logged per status code and per minute. */
export const CLIENT_ERROR_LOG_PER_MINUTE = 20;

/** 4xx status of an `http-errors`-style error (Express/body-parser), or null for anything else. */
export function httpErrorStatus(exception: unknown): number | null {
  const candidate = (exception as { status?: unknown; statusCode?: unknown; expose?: unknown } | null) ?? {};
  const status = candidate.status ?? candidate.statusCode;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) return null;
  return candidate.expose === false ? null : status;
}

@Injectable()
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  /** One WARN line per client body error (no stack), at most {@link BODY_ERROR_LOG_PER_MINUTE} per category, then a count. */
  private readonly bodyErrorLog = new RateLimitedLog({
    name: '[AppExceptionFilter] client body errors',
    perWindow: BODY_ERROR_LOG_PER_MINUTE,
    windowMs: 60_000,
    write: (line) => console.warn(line),
  });

  /** The other 4xx lines, category = status code (5xx are never limited: they stay on every request). */
  private readonly clientErrorLog = new RateLimitedLog({
    name: '[AppExceptionFilter] client errors',
    perWindow: CLIENT_ERROR_LOG_PER_MINUTE,
    windowMs: 60_000,
    write: (line) => console.warn(line),
  });

  constructor(private readonly prowlService: ProwlService) {}

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const executionContext = host as ExecutionContext;
    const serviceName = executionContext.getClass()?.name ?? 'UnknownService';
    const functionName = executionContext.getHandler()?.name ?? 'unknownFunction';
    const clientIp = request.ip || request.socket?.remoteAddress || 'unknown';
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'ERR';
    const message = exception.message;
    // Logged paths never carry the query string nor a secret-looking segment (webhook secrets, share tokens…), and
    // neither does the message (Nest's 404 quotes the URL): `utils/redactPath.ts`. The response itself is unchanged.
    const rawUrl = request.originalUrl ?? request.url;
    const endpoint = `${request.method} ${redactPath(rawUrl)}`;
    const logMessage = redactUrlIn(String(message ?? ''), rawUrl);
    // body-parser errors (413 too large, 400 malformed JSON, 415 charset/encoding…): Nest hands malformed JSON over as a
    // plain BadRequestException, hence the tag set on the request by `configureHttpApp` (`tagBodyParserErrors`).
    const bodyError = bodyParserErrorOf(request) ?? bodyParserErrorInfo(exception);
    if (bodyError) {
      status = exception instanceof HttpException ? exception.getStatus() : bodyError.status;
      this.logBodyError(bodyError, endpoint, clientIp);
    } else if (exception instanceof AppException) {
      status = exception.getStatus();
      code = exception.code;
      this.logWarning(
        status,
        `[AppExceptionFilter] ${exception.constructor.name} (${code}) : ${logMessage} | ip=${clientIp} | endpoint=${endpoint} | service=${serviceName} | function=${functionName}`
      );
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      const detail =
        exceptionResponse && typeof exceptionResponse === 'object'
          ? JSON.stringify(exceptionResponse)
          : String(exceptionResponse);
      this.logWarning(
        status,
        `[AppExceptionFilter] ${exception.constructor.name} (${status}) : ${logMessage} | ip=${clientIp} | endpoint=${endpoint} | detail=${redactUrlIn(detail, rawUrl)}`
      );
    } else if (httpErrorStatus(exception) !== null) {
      // http-errors raised by Express middleware (body-parser: 413 payload too large, 400 malformed JSON…) carry the
      // client's mistake as `status`: answer with it, and do not page the operator for a visitor's bad request.
      status = httpErrorStatus(exception) as number;
      this.logWarning(
        status,
        `[AppExceptionFilter] ${exception.constructor?.name ?? 'HttpError'} (${status}) : ${logMessage} | ip=${clientIp} | endpoint=${endpoint}`
      );
    } else {
      console.error(`[AppExceptionFilter] Unhandled exception (ip=${clientIp}):`, exception);
      this.prowlService.safeNotify(
        'Unhandled Exception',
        `${endpoint} | ip=${clientIp} | ${serviceName}.${functionName}\n${logMessage}`
      );
    }
    // For HttpExceptions (e.g. validation errors from ValidationPipe), include the full
    // response payload so callers can surface specific field errors.
    const httpExceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const responseBody: Record<string, any> = {
      code: code,
      message: message,
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
    };
    if (httpExceptionResponse && typeof httpExceptionResponse === 'object') {
      const { message: _m, statusCode: _s, ...rest } = httpExceptionResponse as Record<string, any>;
      if (Object.keys(rest).length > 0) responseBody.details = rest;
      // If the response contains an array of validation messages, expose them and use them as message
      if (Array.isArray((httpExceptionResponse as any).message)) {
        responseBody.errors = (httpExceptionResponse as any).message;
        responseBody.message = (responseBody.errors as string[]).join('; ');
      }
    }

    if (!response.headersSent) {
      response.status(responseBody.statusCode).send(responseBody);
    }
  }

  /** A 4xx line goes through the per-status limiter (any remote caller can repeat it at will); any other status is always written. */
  private logWarning(status: number, line: string): void {
    if (status >= 400 && status <= 499) this.clientErrorLog.log(String(status), line);
    else console.warn(line);
  }

  /** One line (status, type, method + redacted path, client IP), never the error object: no stack, no body excerpt. */
  private logBodyError({ status, type }: BodyParserErrorInfo, endpoint: string, clientIp: string): void {
    this.bodyErrorLog.log(
      `${status} ${type}`,
      `[AppExceptionFilter] Client body error (${status} ${type}) | ip=${clientIp} | endpoint=${endpoint}`,
    );
  }
}
