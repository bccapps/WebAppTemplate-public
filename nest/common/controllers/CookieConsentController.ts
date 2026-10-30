/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CookieConsentLogDto } from '../dtos/CookieConsentLogDto';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../decorators/Public';
import { CookieConsentService } from '../services/CookieConsentService';
import { extractClientIp } from '../utils/clientRequest';

/** Budget of the anonymous consent log (each call writes a row): a visitor posts once or twice. */
export const COOKIE_CONSENT_THROTTLE = { limit: 10, ttl: 600_000 };

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
  @Throttle({ default: COOKIE_CONSENT_THROTTLE })
  @Post('/api/v1/cookie-consent')
  async log(@Body() body: CookieConsentLogDto, @Req() request: Request): Promise<{ success: true }> {
    await this.cookieConsentService.log({
      ip: extractClientIp(request),
      userAgent: request.headers['user-agent']?.toString() ?? null,
      categories: { necessary: true, audienceMeasurement: body.categories.audienceMeasurement },
    });
    return { success: true };
  }
}
