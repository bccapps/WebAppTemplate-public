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
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { API_SCOPE_KEY } from '../decorators/ApiScope';
import { IS_PUBLIC_KEY } from '../decorators/Public';
import { SecurityException } from '../exceptions/SecurityException';
import { AUTH_PORT, type AuthPort } from './AuthPort';
import {
  applyPrincipal,
  ensureRequestMembers,
  extractBearerToken,
  resolveTokenOnce,
  unrecognizedTokenError,
  type AuthRequest,
} from './authRequest';
import { resetRequestIdentity } from './requestIdentity';
import type { LocalTrustRequest } from './localTrust';
import { SERVICE_KEY_AUTH, type ServiceKeyAuthenticator, type ServiceKeyRequest } from './ServiceKeyAuth';

/**
 * Global authentication interceptor backed by the AuthPort.
 * - `users` mode: a valid token is mandatory (same behaviour as the legacy user AuthInterceptor).
 * - `anonymous` mode: no token passes without `req.user`; a token must be valid.
 * - On a route marked `@ApiScope(scope)`, a service API key is admitted instead of a user token when the optional
 *   `SERVICE_KEY_AUTH` provider is present: `req.servicePrincipal` is set, `req.user` stays undefined.
 */
@Injectable()
export class GlobalAuthInterceptor implements NestInterceptor {
  constructor(
    @Inject(AUTH_PORT) private readonly port: AuthPort,
    private readonly reflector: Reflector,
    @Optional() @Inject(SERVICE_KEY_AUTH) private readonly serviceKeys?: ServiceKeyAuthenticator,
  ) {}

  async intercept(
    context: ExecutionContext,
    handler: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    // First, before any early return: a client-supplied `user`/`uid` (body, query, params) never
    // survives — public controllers read `body.user` for entitlements, and Express 5's `query`
    // getter used to keep the client's `uid` whatever the interceptor wrote.
    resetRequestIdentity(req);

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return handler.handle();

    if (req.user) return handler.handle();
    if (await this.admitServiceKey(context, req)) return handler.handle();

    const token = extractBearerToken(req);
    if (!token) {
      if (this.port.mode !== 'anonymous') throw new SecurityException('AUT', 'Unauthorized');
      const local = this.port.resolveRequest?.(req as unknown as LocalTrustRequest) ?? null;
      if (local) applyPrincipal(req, local);
      return handler.handle();
    }
    ensureRequestMembers(req);
    const { principal, error } = await resolveTokenOnce(this.port, req, token);
    if (error !== undefined) throw error;
    if (!principal) throw unrecognizedTokenError(token);
    applyPrincipal(req, principal);
    return handler.handle();
  }

  /** Service-key branch, only on `@ApiScope` routes and only when a provider is linked. Checked before the bearer
   *  token so a key sent as `Authorization: Bearer <prefixed key>` is not mistaken for an unknown JWT. */
  private async admitServiceKey(context: ExecutionContext, req: AuthRequest): Promise<boolean> {
    if (!this.serviceKeys) return false;
    const scope = this.reflector.getAllAndOverride<string | undefined>(API_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!scope) return false;
    const principal = await this.serviceKeys.authenticate(req as ServiceKeyRequest, scope);
    if (!principal) return false;
    req.servicePrincipal = principal;
    return true;
  }
}
