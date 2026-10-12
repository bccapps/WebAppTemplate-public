/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  Controller,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequireAuthInterceptor } from '../../common/auth';
import { VoiceSttService } from '../services/VoiceSttService';

@Controller('/api/v1/voice/stt')
@UseInterceptors(RequireAuthInterceptor)
export class VoiceSttController {
  constructor(private readonly sttService: VoiceSttService) {}

  @Post()
  async transcribe(
    @Query('accessId') accessId: string,
    @Query('language') language: string | undefined,
    @Query('model') model: string | undefined,
    @Req() req: Request,
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const audioBuffer = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] ?? 'audio/wav';

    const result = await this.sttService.transcribe(Number(accessId), {
      audio: audioBuffer,
      contentType,
      language,
      model,
    });

    return { data: result };
  }
}
