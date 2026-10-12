/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { VoiceCallParams } from '../../types/VoiceCallParams';
import type { TtsRequest, TtsResponse } from '../../types/TtsTypes';

@Injectable()
export class GoogleCloudTtsClient {
  private readonly logger = new Logger(GoogleCloudTtsClient.name);

  async synthesize(params: VoiceCallParams, request: TtsRequest): Promise<TtsResponse> {
    const baseUrl = params.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/text:synthesize`;

    const body = {
      input: { text: request.text },
      voice: {
        languageCode: request.language ?? 'en-US',
        ...(request.voice ? { name: request.voice } : {}),
      },
      audioConfig: {
        audioEncoding: this.mapFormat(request.outputFormat),
        ...(request.speed ? { speakingRate: request.speed } : {}),
      },
    };

    const res = await fetch(`${url}?key=${params.password}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`Google Cloud TTS error: ${res.status} ${text}`);
      throw new Error(`Google Cloud TTS failed: ${res.status}`);
    }

    const json = await res.json() as { audioContent: string };
    const audio = Buffer.from(json.audioContent, 'base64');
    return {
      audio,
      contentType: this.getContentType(request.outputFormat),
    };
  }

  private mapFormat(format?: string): string {
    switch (format) {
      case 'wav': return 'LINEAR16';
      case 'ogg': return 'OGG_OPUS';
      default: return 'MP3';
    }
  }

  private getContentType(format?: string): string {
    switch (format) {
      case 'wav': return 'audio/wav';
      case 'ogg': return 'audio/ogg';
      default: return 'audio/mpeg';
    }
  }
}
