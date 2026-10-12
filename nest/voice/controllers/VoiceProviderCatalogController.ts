/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseInterceptors,
} from '@nestjs/common';
import { AdminOnlyInterceptor } from '../../common/interceptors/AdminOnlyInterceptor';
import { RequireAuthInterceptor } from '../../common/auth';
import { IdParamDto } from '../../common/dtos/IdParamDto';
import { UpsertVoiceProviderCatalogDto } from '../dto/UpsertVoiceProviderCatalogDto';
import { VoiceProviderCatalogService } from '../services/VoiceProviderCatalogService';

@Controller('/api/v1/voice-provider-catalog')
export class VoiceProviderCatalogController {
  constructor(private readonly catalogService: VoiceProviderCatalogService) {}

  @Get()
  @UseInterceptors(RequireAuthInterceptor)
  async list() {
    const data = await this.catalogService.list();
    return { data };
  }

  @Post()
  @UseInterceptors(AdminOnlyInterceptor)
  async create(@Body() payload: UpsertVoiceProviderCatalogDto) {
    const data = await this.catalogService.create(payload);
    return { data };
  }

  @Put(':id')
  @UseInterceptors(AdminOnlyInterceptor)
  async update(@Param() params: IdParamDto, @Body() payload: UpsertVoiceProviderCatalogDto) {
    const data = await this.catalogService.update(params.id, payload);
    return { data };
  }

  @Delete(':id')
  @UseInterceptors(AdminOnlyInterceptor)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param() params: IdParamDto) {
    return this.catalogService.delete(params.id);
  }
}
