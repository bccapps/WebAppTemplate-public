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
import { Observable } from 'rxjs';
import { SecurityException } from '../exceptions/SecurityException';
import type { AuthRequest } from './authRequest';

/**
 * Requires any authenticated principal (user or admin-token). In `users` mode
 * this equals the legacy AuthInterceptor; in `anonymous` mode only the admin passes.
 */
@Injectable()
export class RequireAuthInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, handler: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (!req.user) {
      throw new SecurityException('AUT', 'Unauthorized');
    }
    return handler.handle();
  }
}
