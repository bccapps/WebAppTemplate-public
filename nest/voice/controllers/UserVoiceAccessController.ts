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
  Req,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequireUserInterceptor } from '../../common/auth';
import { IdParamDto } from '../../common/dtos/IdParamDto';
import { UserUpsertVoiceAccessDto } from '../dto/UserUpsertVoiceAccessDto';
import { UserVoiceAccessService } from '../services/UserVoiceAccessService';

@Controller('/api/v1/user/voice-accesses')
@UseInterceptors(RequireUserInterceptor)
export class UserVoiceAccessController {
  constructor(
    private readonly userVoiceAccessService: UserVoiceAccessService,
  ) {}

  private getUid(req: Request): number {
    const uid =
      (req as any)?.params?.uid ??
      (req as any)?.query?.uid ??
      (req as any)?.body?.uid;
    return typeof uid === 'string' ? Number(uid) : Number(uid ?? 0);
  }

  @Get()
  async list(@Req() req: Request) {
    const userId = this.getUid(req);
    const data = await this.userVoiceAccessService.list(userId);
    return { data };
  }

  @Post()
  async create(@Req() req: Request, @Body() payload: UserUpsertVoiceAccessDto) {
    const userId = this.getUid(req);
    const data = await this.userVoiceAccessService.create(userId, payload);
    return { data };
  }

  @Put(':id')
  async update(
    @Req() req: Request,
    @Param() params: IdParamDto,
    @Body() payload: UserUpsertVoiceAccessDto,
  ) {
    const userId = this.getUid(req);
    const data = await this.userVoiceAccessService.update(
      userId,
      params.id,
      payload,
    );
    return { data };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Req() req: Request, @Param() params: IdParamDto) {
    const userId = this.getUid(req);
    await this.userVoiceAccessService.delete(userId, params.id);
  }
}
