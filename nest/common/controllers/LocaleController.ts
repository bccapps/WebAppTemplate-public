/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { LocaleService } from '../services/LocaleService';
import { Public } from '../decorators/Public';
import { NoTransportCrypt } from '../decorators/NoTransportCrypt';
import { CacheControl } from '../decorators/CacheControl';

// Decision C (PERFORMANCE_PLAN.md §2.0): interface copy, no business data — both
// routes below are exempted from transport encryption so gzip/edge caching can
// apply (§2.1). The cache key already varies by URL (query string included), so
// /locales?lang=fr and /locales?lang=en are cached as distinct entries without
// needing a Vary header.
@Public()
@NoTransportCrypt()
@CacheControl({
  visibility: 'public',
  maxAgeConfigKey: 'common_cacheControl_locales_maxAge',
  staleWhileRevalidateConfigKey: 'common_cacheControl_locales_staleWhileRevalidate',
})
@ApiTags('locale')
@Controller()
export class LocaleController {
  constructor(private readonly localeService: LocaleService) {}

  @ApiOkResponse({
    description: 'Locale loaded',
    type: Object
  })
  @Get('/api/v1/locales/:category')
  async getLocale(@Param('category') category: string): Promise<any> {
    return await this.localeService.getLocale(category);
  }

  @ApiOkResponse({
    description: 'All locales loaded',
    type: Object
  })
  @ApiQuery({
    name: 'lang',
    required: false,
    description: 'When given, only that language is returned (e.g. { fr: {...} }) instead of every configured language.',
  })
  @Get('/api/v1/locales')
  async getAllLocales(@Query('lang') lang?: string): Promise<Record<string, Record<string, any>>> {
    return await this.localeService.getAllLocales(lang);
  }
}
