/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Get, Param, Put, UseInterceptors } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { FunctionalException } from '../exceptions/FunctionalException';
import { ModuleConfigService } from '../services/ModuleConfigService';
import { ModuleConfigSchema, ModuleConfigWithValues } from '../types/ModuleConfigSchema';
import { AdminOnlyInterceptor } from '../interceptors/AdminOnlyInterceptor';

@ApiTags('module-config')
@UseInterceptors(AdminOnlyInterceptor)
@Controller()
export class ModuleConfigController {
  constructor(private readonly moduleConfigService: ModuleConfigService) {}

  @ApiOkResponse({
    description: 'All module configuration schemas',
  })
  @Get('/api/v1/admin/module-configs/schemas')
  getSchemas(): ModuleConfigSchema[] {
    return this.moduleConfigService.getAllSchemas();
  }

  @ApiOkResponse({
    description: 'All module configurations with current values',
  })
  @Get('/api/v1/admin/module-configs')
  async getAllWithValues(): Promise<ModuleConfigWithValues[]> {
    return this.moduleConfigService.getAllModuleConfigsWithValues();
  }

  @ApiOkResponse({
    description: 'Module configuration with current values',
  })
  @ApiBadRequestResponse({
    description: 'Module not found',
    type: FunctionalException,
  })
  @Get('/api/v1/admin/module-configs/:moduleId')
  async getModuleConfig(@Param('moduleId') moduleId: string): Promise<ModuleConfigWithValues> {
    const config = await this.moduleConfigService.getModuleConfigWithValues(moduleId);
    if (!config) {
      throw new FunctionalException('MCC', `Module '${moduleId}' not found`);
    }
    return config;
  }

  @ApiOkResponse({
    description: 'Decrypted value of a single secret field',
  })
  @ApiBadRequestResponse({
    description: 'Module not found or field is not a secret field',
    type: FunctionalException,
  })
  @Get('/api/v1/admin/module-configs/:moduleId/secret/:key')
  async getSecretValue(
    @Param('moduleId') moduleId: string,
    @Param('key') key: string,
  ): Promise<{ value: string }> {
    const value = this.moduleConfigService.getDecryptedSecretValue(moduleId, key);
    if (value === null) {
      throw new FunctionalException('MCC', `Secret field '${key}' not found for module '${moduleId}'`);
    }
    return { value };
  }

  @ApiOkResponse({
    description: 'Module configuration updated',
  })
  @ApiBadRequestResponse({
    description: 'Module not found or invalid values',
    type: FunctionalException,
  })
  @Put('/api/v1/admin/module-configs/:moduleId')
  async updateModuleConfig(
    @Param('moduleId') moduleId: string,
    @Body() values: Record<string, any>,
  ): Promise<ModuleConfigWithValues> {
    const config = await this.moduleConfigService.updateModuleConfig(moduleId, values);
    if (!config) {
      throw new FunctionalException('MCC', `Module '${moduleId}' not found`);
    }
    return config;
  }
}
