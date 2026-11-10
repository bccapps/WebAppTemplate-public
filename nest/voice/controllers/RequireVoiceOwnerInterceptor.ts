/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { SecurityException } from '../../common/exceptions/SecurityException';
import type { AuthRequest } from '../../common/auth/authRequest';

/**
 * Who may own voice accesses: a signed-in user, or the local person of a standalone desktop app.
 *
 * `RequireUserInterceptor` refuses `local-trust` outright, because the plain local-trust principal is an administrator with no row of its own
 * (id 0): nobody to own anything. An app that gives its local person a real `user` row (the desktop flavor of AgentHub: the principal then
 * carries that row's id, `LocalUserAuthProvider`) makes the principal a real owner, and this interceptor lets it through: `kind: 'local-trust'`
 * with a positive integer id. Id 0, the `ADMIN_TOKEN` identity and an anonymous request stay refused, so a hub (which never runs
 * `LOCAL_TRUST`: the server refuses to start on a non-loopback host) behaves exactly as with `RequireUserInterceptor`.
 */
@Injectable()
export class RequireVoiceOwnerInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, handler: CallHandler): Observable<unknown> {
    const user = context.switchToHttp().getRequest<AuthRequest>().user;
    if (!user || user.kind === 'admin-token') throw new SecurityException('AUT', 'Unauthorized');
    if (user.kind === 'local-trust' && !(Number.isInteger(user.id) && user.id > 0)) throw new SecurityException('AUT', 'Unauthorized');
    return handler.handle();
  }
}
