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
 * For routes that belong to a real user: rejects anonymous requests and the
 * ADMIN_TOKEN identity. Relies on `req.user` set by the global interceptor.
 */
@Injectable()
export class RequireUserInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, handler: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (!req.user || req.user.kind === 'admin-token') {
      throw new SecurityException('AUT', 'Unauthorized');
    }
    return handler.handle();
  }
}
