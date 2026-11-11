/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import type { AuthRequest } from '../../common/auth/authRequest';
import { SecurityException } from '../../common/exceptions/SecurityException';
import { extractClientIp } from '../../common/utils/clientRequest';
import type { ChannelOwner } from '../types/providerTypes';

/**
 * Defence in depth on top of `RequireUserInterceptor` for `/interaction/me/*` (invariant 13, 04 §14 « agent that
 * configures its own channel »). FAILS CLOSED (second review, finding 6): only a principal of kind `user` that carries
 * the POSITIVE marker `isHumanSession === true`, and never one flagged `isApiToken === true`, nor a request that also
 * carries a service key or a machine credential (an `@ApiScope` service principal, an MCP principal). Contract with the
 * `user` module (lot S): it sets `isHumanSession` on the principals of real sessions (a session id `sid > 0`) and
 * `isApiToken` on user JWTs issued as API tokens (`POST /users/admin/:id/api-token`, `aud=api`). A principal with
 * neither flag (an `AuthPort` that does not set them yet) is refused: every refusal is the same `401`.
 */
@Injectable()
export class RequireHumanSessionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthRequest & Record<string, unknown>>();
    if (!isHumanSessionRequest(req)) throw new SecurityException('AUT', 'Unauthorized');
    return next.handle();
  }
}

/** The rule of `RequireHumanSessionInterceptor` (exported for its tests): a real user session, nothing machine-like. */
export function isHumanSessionRequest(req: AuthRequest & Record<string, unknown>): boolean {
  const user = req.user;
  if (!user || user.kind !== 'user' || !Number.isSafeInteger(user.id) || user.id <= 0) return false;
  if (user.isHumanSession !== true || user.isApiToken === true) return false;
  return req.servicePrincipal === undefined && req.mcpPrincipal === undefined && req.mcpCredential === undefined;
}

/** The session user of a `/me` route, as a channel owner (client address from `req.ip`, never a forwarded header). */
export function ownerOf(req: Request): ChannelOwner {
  const user = (req as unknown as AuthRequest).user;
  if (!user || user.kind !== 'user') throw new SecurityException('AUT', 'Unauthorized');
  return { userId: user.id, admin: user.admin === true, ip: extractClientIp(req) };
}

/** The administrator of an `/admin` route: `null` for the admin key or local trust (no user account). */
export function adminActorOf(req: Request): { userId: number | null } {
  const user = (req as unknown as AuthRequest).user;
  return { userId: user && user.kind === 'user' ? user.id : null };
}
