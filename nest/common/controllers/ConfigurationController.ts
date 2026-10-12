/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Get, Put, UseInterceptors } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import ConfigurationDto from '../dtos/ConfigurationDto';
import { FunctionalException } from '../exceptions/FunctionalException';
import { ConfigurationService } from '../services/ConfigurationService';
import { Public } from '../decorators/Public';
import { AdminOnlyInterceptor } from '../interceptors/AdminOnlyInterceptor';
import { NoTransportCrypt } from '../decorators/NoTransportCrypt';
import { CacheControl } from '../decorators/CacheControl';

@ApiTags('configuration')
@Controller()
export class ConfigurationController {
  constructor(private readonly configurationService: ConfigurationService) {}

  @ApiOkResponse({
    description: 'Configuration loaded',
    type: ConfigurationDto
  })
  @ApiBadRequestResponse({
    description: 'Bad request or arguments',
    type: FunctionalException
  })
  @Public()
  // Decision C (PERFORMANCE_PLAN.md §2.0): public config flags, no business data —
  // exempted from transport encryption so gzip/edge caching can apply (§2.1).
  @NoTransportCrypt()
  @CacheControl({
    visibility: 'public',
    maxAgeConfigKey: 'common_cacheControl_configurations_maxAge',
    staleWhileRevalidateConfigKey: 'common_cacheControl_configurations_staleWhileRevalidate',
  })
  @Get('/api/v1/configurations')
  async getConfiguration(): Promise<ConfigurationDto[]> {
    return await this.configurationService.getPublicConfiguration();
  }

  @ApiOkResponse({
    description: 'Global configuration (excludes module-owned keys)',
    type: ConfigurationDto
  })
  @UseInterceptors(AdminOnlyInterceptor)
  @Get('/api/v1/admin/configurations')
  async getGlobalConfiguration(): Promise<ConfigurationDto[]> {
    return await this.configurationService.getGlobalConfiguration();
  }

  @ApiOkResponse({
    description: 'Module API URLs (api_url_* keys only)',
    type: ConfigurationDto
  })
  @UseInterceptors(AdminOnlyInterceptor)
  @Get('/api/v1/admin/configurations/module-urls')
  async getModuleUrls(): Promise<ConfigurationDto[]> {
    return await this.configurationService.getModuleUrls();
  }

  @ApiOkResponse({
    description: 'Configuration updated',
    type: ConfigurationDto
  })
  @UseInterceptors(AdminOnlyInterceptor)
  @Put('/api/v1/configurations')
  async updateConfiguration(@Body() payload: ConfigurationDto[]): Promise<ConfigurationDto[]> {
    return await this.configurationService.updateAll(payload);
  }
}
