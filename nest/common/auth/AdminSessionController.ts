/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Controller, Get, Inject, UseInterceptors } from '@nestjs/common';
import { AdminOnlyInterceptor } from '../interceptors/AdminOnlyInterceptor';
import { AUTH_PORT, type AuthPort } from './AuthPort';

/** Lets the front validate an admin key (see AdminTokenGate). */
@Controller()
export class AdminSessionController {
  constructor(@Inject(AUTH_PORT) private readonly port: AuthPort) {}

  @Get('/api/v1/admin-session')
  @UseInterceptors(AdminOnlyInterceptor)
  session(): { admin: true; mode: AuthPort['mode'] } {
    return { admin: true, mode: this.port.mode };
  }
}
