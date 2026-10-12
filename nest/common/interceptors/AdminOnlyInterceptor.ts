/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { SecurityException } from '../exceptions/SecurityException';

/**
 * Lightweight admin check — assumes the global AuthInterceptor already
 * validated the token and set req.user.  Only verifies req.user.admin.
 * Use this on controllers that live in CommonModule (no UserService dep).
 */
@Injectable()
export class AdminOnlyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, handler: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    if (!req.user) {
      throw new SecurityException('AUT', 'Unauthorized');
    }
    if (!req.user.admin) {
      throw new SecurityException('AUT', 'Admin access required');
    }
    return handler.handle();
  }
}
