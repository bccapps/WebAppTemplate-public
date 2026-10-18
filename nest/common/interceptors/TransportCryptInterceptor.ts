/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { from, Observable, of } from 'rxjs';
import { concatMap, switchMap } from 'rxjs/operators';
import {
  DEFAULT_TRANSPORT_DEFLATE_THRESHOLD_BYTES,
  TRANSPORT_ACCEPT_ENCODING_HEADER,
  TRANSPORT_ENCODING_DEFLATE,
  TRANSPORT_ENCRYPTED_HEADER,
  TRANSPORT_PAYLOAD_VERSION,
  TRANSPORT_PAYLOAD_VERSION_LEGACY,
  TRANSPORT_SESSION_HEADER,
  TRANSPORT_VERSION_HEADER,
} from '../constants/crypt.constants';
import { NO_TRANSPORT_CRYPT_KEY } from '../decorators/NoTransportCrypt';
import { CryptService } from '../services/CryptService';
import { CryptSessionService } from '../services/CryptSessionService';
import { ConfigurationService } from '../services/ConfigurationService';

@Injectable()
export class TransportCryptInterceptor implements NestInterceptor {
  constructor(
    private readonly cryptService: CryptService,
    private readonly cryptSessionService: CryptSessionService,
    private readonly configurationService: ConfigurationService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    if (process.env.DISABLE_TRANSPORT_CRYPTO === 'true') {
      return next.handle();
    }

    // Decision C (PERFORMANCE_PLAN.md §2.0): a closed, explicit allowlist of
    // infrastructure routes (config flags, locales, catalogue metadata) skips
    // encryption entirely — including the Redis session lookup below, which
    // these routes have no need for. See NoTransportCrypt.ts for the exact list.
    const isExempt = this.reflector.getAllAndOverride<boolean | undefined>(NO_TRANSPORT_CRYPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isExempt) {
      return next.handle();
    }

    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();
    const sessionId = request.headers[TRANSPORT_SESSION_HEADER] as string | undefined;

    if (!sessionId) {
      return next.handle();
    }

    // Presence of this header (any value) means the caller's JS understands the v2 wire
    // format (5 segments, compression flag). Its absence means a client that predates this
    // rollout — e.g. a front bundle served from the browser cache — which only knows how to
    // parse the legacy v1 format (4 segments, never compressed). See crypt.constants.ts.
    const acceptEncoding = request.headers[TRANSPORT_ACCEPT_ENCODING_HEADER] as string | undefined;
    const supportsV2 = acceptEncoding !== undefined;
    const acceptsDeflate = acceptEncoding === TRANSPORT_ENCODING_DEFLATE;

    return from(this.cryptSessionService.peekSession(sessionId)).pipe(
      switchMap((session) => {
        if (!session) {
          return next.handle();
        }
        return next.handle().pipe(
          // concatMap (not mergeMap): one HTTP response = one emitted body, kept in order.
          concatMap(async (body) => {
            if (response.writableEnded || response.headersSent) {
              return body;
            }
            const thresholdBytes = Number(
              this.configurationService.get('common_transport_deflate_threshold')
                ?? DEFAULT_TRANSPORT_DEFLATE_THRESHOLD_BYTES,
            );
            // Async: the deflate of a large series payload runs on the zlib thread pool, not the event loop.
            const encryptedPayload = await this.cryptService.encryptForTransportAsync(body, session.key, {
              legacy: !supportsV2,
              deflate: acceptsDeflate,
              thresholdBytes,
            });
            response.setHeader(TRANSPORT_ENCRYPTED_HEADER, '1');
            response.setHeader(
              TRANSPORT_VERSION_HEADER,
              supportsV2 ? TRANSPORT_PAYLOAD_VERSION : TRANSPORT_PAYLOAD_VERSION_LEGACY,
            );
            return { payload: encryptedPayload };
          }),
        );
      }),
    );
  }
}
