/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Controller, Get, Inject, Req, UseInterceptors } from '@nestjs/common';
import { AdminOnlyInterceptor } from '../interceptors/AdminOnlyInterceptor';
import { AUTH_PORT, type AuthPort } from './AuthPort';
import type { AuthRequest } from './authRequest';

/** Lets the front validate an admin key (see AdminTokenGate). */
@Controller()
export class AdminSessionController {
  constructor(@Inject(AUTH_PORT) private readonly port: AuthPort) {}

  @Get('/api/v1/admin-session')
  @UseInterceptors(AdminOnlyInterceptor)
  session(@Req() req: AuthRequest): { admin: true; mode: AuthPort['mode'] | 'local-trust' } {
    return { admin: true, mode: req.user?.kind === 'local-trust' ? 'local-trust' : this.port.mode };
  }
}
