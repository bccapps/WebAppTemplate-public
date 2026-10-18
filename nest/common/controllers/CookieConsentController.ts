/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Post, Req } from '@nestjs/common';
import { CookieConsentLogDto } from '../dtos/CookieConsentLogDto';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../decorators/Public';
import { CookieConsentService } from '../services/CookieConsentService';

@ApiTags('cookie-consent')
@Controller()
export class CookieConsentController {
  constructor(private readonly cookieConsentService: CookieConsentService) {}

  /**
   * Fire-and-forget from the consent banner/modal — logged anonymously (no `OptionalAuthInterceptor`
   * here, to avoid a common→user reverse module dependency for a nice-to-have; the client-side
   * cookie is the actual enforcement mechanism, this is only the CNIL proof-of-consent record).
   */
  @ApiOkResponse({ description: 'Log a cookie-consent choice (anonymous, proof-of-consent record)' })
  @Public()
  @Post('/api/v1/cookie-consent')
  async log(@Body() body: CookieConsentLogDto, @Req() request: Request): Promise<{ success: true }> {
    const ip = request.ip || request.headers['x-forwarded-for']?.toString().split(',')[0] || null;
    await this.cookieConsentService.log({
      ip,
      userAgent: request.headers['user-agent']?.toString() ?? null,
      categories: { necessary: true, audienceMeasurement: body.categories.audienceMeasurement },
    });
    return { success: true };
  }
}
