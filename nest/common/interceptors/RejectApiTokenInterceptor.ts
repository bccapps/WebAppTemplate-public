/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { PrincipalRefusedException } from './PrincipalRefusedException';

/**
 * NEGATIVE guard: refuses (403 `API_TOKEN_NOT_ALLOWED`) a request whose principal is a static API token
 * (`req.user.isApiToken === true`, a never-expiring machine credential of an account, even an administrator's);
 * anything else passes untouched (no principal, local-trust, admin-token, service key, session, an app without the
 * `user` module…). It does NOT authenticate: it must run after the app's auth (global auth, then the route's own
 * auth/admin interceptors), and a request without a principal keeps getting the auth layer's answer.
 *
 * Duck-typed on purpose (`common` never imports the `user` module). Use it where a positive check would break a
 * legitimate non-session flow (anonymous checkout with an optional auth, local-trust desktop apps, admin-token mode);
 * for routes only a signed-in person uses, prefer {@link RequireHumanSessionInterceptor}.
 */
@Injectable()
export class RejectApiTokenInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user = context.switchToHttp().getRequest<{ user?: { isApiToken?: unknown } | null }>().user;
    if (user?.isApiToken === true) {
      throw new PrincipalRefusedException('API_TOKEN_NOT_ALLOWED', 'An API token cannot use this route: sign in with a user session');
    }
    return next.handle();
  }
}
