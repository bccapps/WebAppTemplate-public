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
  Query,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IdParamDto } from '../../common/dtos/IdParamDto';
import { UserUpsertVoiceAccessDto } from '../dto/UserUpsertVoiceAccessDto';
import { TtsRequestDto } from '../dto/TtsRequestDto';
import { UserVoiceAccessService } from '../services/UserVoiceAccessService';
import { VoiceUserDispatchService } from '../services/VoiceUserDispatchService';
import { RequireVoiceOwnerInterceptor } from './RequireVoiceOwnerInterceptor';

@Controller('/api/v1/user/voice-accesses')
@UseInterceptors(RequireVoiceOwnerInterceptor)
export class UserVoiceAccessController {
  constructor(
    private readonly userVoiceAccessService: UserVoiceAccessService,
    private readonly dispatch: VoiceUserDispatchService,
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

  /**
   * Text to speech with one of the caller's own accesses (404 for an access of someone else, 403 when user providers are disabled).
   * `params.id` is a string when the app registers no global ValidationPipe with `transform` (AgentHub does not): `Number(...)` gives the dispatch its integer id.
   */
  @Post(':id/tts')
  @HttpCode(HttpStatus.OK)
  async synthesize(
    @Req() req: Request,
    @Param() params: IdParamDto,
    @Body() payload: TtsRequestDto,
    @Res() res: Response,
  ) {
    const result = await this.dispatch.synthesize(this.getUid(req), Number(params.id), {
      text: payload.text,
      voice: payload.voice,
      language: payload.language,
      speed: payload.speed,
      outputFormat: payload.outputFormat,
      gender: payload.gender,
    });
    res.set('Content-Type', result.contentType);
    if (result.durationMs !== undefined) res.set('X-Audio-Duration-Ms', String(result.durationMs));
    res.send(result.audio);
  }

  /** Speech to text with one of the caller's own accesses (raw audio body; `language` omitted = detection when the provider offers it). */
  @Post(':id/stt')
  @HttpCode(HttpStatus.OK)
  async transcribe(
    @Req() req: Request,
    @Param() params: IdParamDto,
    @Query('language') language: string | undefined,
    @Query('model') model: string | undefined,
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const result = await this.dispatch.transcribe(this.getUid(req), Number(params.id), {
      audio: Buffer.concat(chunks),
      contentType: req.headers['content-type'] ?? 'audio/wav',
      language: language || undefined,
      model: model || undefined,
    });
    return { data: result };
  }
}
