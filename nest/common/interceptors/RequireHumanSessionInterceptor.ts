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
 * POSITIVE guard, fail closed: passes only a person's session principal, i.e. `req.user.kind === 'user'` AND
 * `req.user.isHumanSession === true` (strictly the boolean) AND `req.user.isApiToken !== true`. Every other principal
 * (API token, local-trust, admin-token, service key, a legacy principal without markers, a string `'true'`) gets
 * 403 `HUMAN_SESSION_REQUIRED`.
 *
 * It does NOT authenticate: it must run AFTER the app's auth so that `req.user` is set (listed after the route's
 * auth/admin interceptor; global interceptors run before it anyway). A request with no `req.user` at all is therefore
 * refused with 403 only if it got past the auth layer, which normally answers 401 first.
 *
 * Duck-typed on purpose (`common` never imports the `user` module, which sets the markers). Only for routes that
 * real signed-in people use; a route with a legitimate non-session caller (anonymous checkout, local-trust desktop
 * flavour) takes {@link RejectApiTokenInterceptor} instead.
 */
@Injectable()
export class RequireHumanSessionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user = context.switchToHttp().getRequest<{ user?: { kind?: unknown; isHumanSession?: unknown; isApiToken?: unknown } | null }>().user;
    if (!user || user.kind !== 'user' || user.isHumanSession !== true || user.isApiToken === true) {
      throw new PrincipalRefusedException('HUMAN_SESSION_REQUIRED', 'This route needs a signed-in person (user session)');
    }
    return next.handle();
  }
}
