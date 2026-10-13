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
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../decorators/Public';
import { SecurityException } from '../exceptions/SecurityException';
import { AUTH_PORT, type AuthPort } from './AuthPort';
import {
  applyPrincipal,
  ensureRequestMembers,
  extractBearerToken,
  unrecognizedTokenError,
  type AuthRequest,
} from './authRequest';
import type { LocalTrustRequest } from './localTrust';

/**
 * Global authentication interceptor backed by the AuthPort.
 * - `users` mode: a valid token is mandatory (same behaviour as the legacy user AuthInterceptor).
 * - `anonymous` mode: no token passes without `req.user`; a token must be valid.
 */
@Injectable()
export class GlobalAuthInterceptor implements NestInterceptor {
  constructor(
    @Inject(AUTH_PORT) private readonly port: AuthPort,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    handler: CallHandler,
  ): Promise<Observable<unknown>> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return handler.handle();

    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (req.user) return handler.handle();

    const token = extractBearerToken(req);
    if (!token) {
      if (this.port.mode !== 'anonymous') throw new SecurityException('AUT', 'Unauthorized');
      const local = this.port.resolveRequest?.(req as unknown as LocalTrustRequest) ?? null;
      if (local) applyPrincipal(req, local);
      return handler.handle();
    }
    ensureRequestMembers(req);
    const principal = await this.port.resolveToken(token);
    if (!principal) throw unrecognizedTokenError(token);
    applyPrincipal(req, principal);
    return handler.handle();
  }
}
