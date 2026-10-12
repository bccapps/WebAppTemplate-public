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
export class ElevenLabsTtsClient {
  private readonly logger = new Logger(ElevenLabsTtsClient.name);

  async synthesize(params: VoiceCallParams, request: TtsRequest): Promise<TtsResponse> {
    const baseUrl = params.baseUrl.replace(/\/+$/, '');
    const voiceId = request.voice ?? params.providerConfig?.voiceId ?? 'EXAVITQu4vr4xnSDxMaL';
    const url = `${baseUrl}/text-to-speech/${voiceId}`;

    const body: Record<string, any> = {
      text: request.text,
      model_id: 'eleven_multilingual_v2',
    };

    if (request.speed) {
      body.voice_settings = {
        stability: 0.5,
        similarity_boost: 0.75,
        speed: request.speed,
      };
    }

    const outputFormat = this.mapFormat(request.outputFormat);

    const res = await fetch(`${url}?output_format=${outputFormat}`, {
      method: 'POST',
      headers: {
        'xi-api-key': params.password ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`ElevenLabs TTS error: ${res.status} ${text}`);
      throw new Error(`ElevenLabs TTS failed: ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      contentType: this.getContentType(request.outputFormat),
    };
  }

  private mapFormat(format?: string): string {
    switch (format) {
      case 'pcm': return 'pcm_16000';
      default: return 'mp3_44100_128';
    }
  }

  private getContentType(format?: string): string {
    switch (format) {
      case 'pcm': return 'audio/pcm';
      default: return 'audio/mpeg';
    }
  }
}
