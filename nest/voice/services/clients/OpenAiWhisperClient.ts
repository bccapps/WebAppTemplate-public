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
import type { SttRequest, SttResponse, SttSegment } from '../../types/SttTypes';

@Injectable()
export class OpenAiWhisperClient {
  private readonly logger = new Logger(OpenAiWhisperClient.name);

  async transcribe(params: VoiceCallParams, request: SttRequest): Promise<SttResponse> {
    const baseUrl = params.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/audio/transcriptions`;

    const ext = this.getExtension(request.contentType);
    const blob = new Blob([request.audio as unknown as BlobPart], { type: request.contentType });

    const formData = new FormData();
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', request.model ?? 'whisper-1');
    formData.append('response_format', 'verbose_json');
    if (request.language) {
      formData.append('language', request.language);
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${params.password}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`OpenAI Whisper error: ${res.status} ${text}`);
      throw new Error(`OpenAI Whisper failed: ${res.status}`);
    }

    const json = await res.json() as any;

    const segments: SttSegment[] = (json.segments ?? []).map((s: any) => ({
      text: s.text,
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
    }));

    return {
      text: json.text ?? '',
      segments,
      language: json.language,
    };
  }

  private getExtension(contentType: string): string {
    if (contentType.includes('wav')) return 'wav';
    if (contentType.includes('mp3') || contentType.includes('mpeg')) return 'mp3';
    if (contentType.includes('webm')) return 'webm';
    if (contentType.includes('ogg')) return 'ogg';
    if (contentType.includes('flac')) return 'flac';
    if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
    return 'wav';
  }
}
