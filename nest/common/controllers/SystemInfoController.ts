/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SystemInfoService } from '../services/SystemInfoService';
import SystemInfoDto from '../dtos/SystemInfoDto';
import { AdminOnlyInterceptor } from '../interceptors/AdminOnlyInterceptor';

@ApiTags('system-info')
@UseInterceptors(AdminOnlyInterceptor)
@Controller()
export class SystemInfoController {
  constructor(private readonly systemInfoService: SystemInfoService) {}

  @ApiOkResponse({
    description: 'Server memory and disk usage',
    type: SystemInfoDto,
  })
  @Get('/api/v1/admin/system-info')
  async getSystemInfo(): Promise<SystemInfoDto> {
    return this.systemInfoService.getSystemInfo();
  }
}
