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
import { IdParamDto } from '../../common/dtos/IdParamDto';
import { UpsertVoiceAccessDto } from '../dto/UpsertVoiceAccessDto';
import { VoiceAccessService } from '../services/VoiceAccessService';

@Controller('/api/v1/voice-accesses')
@UseInterceptors(AdminOnlyInterceptor)
export class VoiceAccessController {
  constructor(
    private readonly voiceAccessService: VoiceAccessService,
  ) {}

  @Get()
  async list() {
    const data = await this.voiceAccessService.listAll();
    return { data };
  }

  @Post()
  async create(@Body() payload: UpsertVoiceAccessDto) {
    const data = await this.voiceAccessService.create(payload);
    return { data };
  }

  @Put(':id')
  async update(
    @Param() params: IdParamDto,
    @Body() payload: UpsertVoiceAccessDto,
  ) {
    const data = await this.voiceAccessService.update(params.id, payload);
    return { data };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param() params: IdParamDto) {
    return this.voiceAccessService.delete(params.id);
  }
}
