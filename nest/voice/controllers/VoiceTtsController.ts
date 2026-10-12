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
  Post,
  Query,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequireAuthInterceptor } from '../../common/auth';
import { TtsRequestDto } from '../dto/TtsRequestDto';
import { VoiceTtsService } from '../services/VoiceTtsService';

@Controller('/api/v1/voice/tts')
@UseInterceptors(RequireAuthInterceptor)
export class VoiceTtsController {
  constructor(private readonly ttsService: VoiceTtsService) {}

  @Post()
  async synthesize(
    @Query('accessId') accessId: string,
    @Body() payload: TtsRequestDto,
    @Res() res: Response,
  ) {
    const result = await this.ttsService.synthesize(Number(accessId), {
      text: payload.text,
      voice: payload.voice,
      language: payload.language,
      speed: payload.speed,
      outputFormat: payload.outputFormat,
    });

    res.set('Content-Type', result.contentType);
    if (result.durationMs !== undefined) {
      res.set('X-Audio-Duration-Ms', String(result.durationMs));
    }
    res.send(result.audio);
  }
}
