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

@Injectable()
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
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
    if (exception instanceof AppException) {
      status = exception.getStatus();
      code = exception.code;
      console.warn(
        `[AppExceptionFilter] ${exception.constructor.name} (${code}) : ${message} | ip=${clientIp} | endpoint=${request.method} ${request.originalUrl ?? request.url} | service=${serviceName} | function=${functionName}`
      );
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      const detail =
        exceptionResponse && typeof exceptionResponse === 'object'
          ? JSON.stringify(exceptionResponse)
          : String(exceptionResponse);
      console.warn(
        `[AppExceptionFilter] ${exception.constructor.name} (${status}) : ${message} | ip=${clientIp} | endpoint=${request.method} ${request.originalUrl ?? request.url} | detail=${detail}`
      );
    } else {
      console.error(`[AppExceptionFilter] Unhandled exception (ip=${clientIp}):`, exception);
      this.prowlService.safeNotify(
        'Unhandled Exception',
        `${request.method} ${request.originalUrl ?? request.url} | ip=${clientIp} | ${serviceName}.${functionName}\n${message}`
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
}
