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
import type { SttRequest, SttResponse } from '../../types/SttTypes';

@Injectable()
export class GoogleCloudSttClient {
  private readonly logger = new Logger(GoogleCloudSttClient.name);

  async transcribe(params: VoiceCallParams, request: SttRequest): Promise<SttResponse> {
    const baseUrl = 'https://speech.googleapis.com/v1';
    const url = `${baseUrl}/speech:recognize?key=${params.password}`;

    const encoding = this.mapEncoding(request.contentType);

    const body = {
      config: {
        encoding,
        sampleRateHertz: 16000,
        languageCode: request.language ?? 'en-US',
        enableWordTimeOffsets: true,
      },
      audio: {
        content: request.audio.toString('base64'),
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`Google Cloud STT error: ${res.status} ${text}`);
      throw new Error(`Google Cloud STT failed: ${res.status}`);
    }

    const json = await res.json() as any;
    const result = json.results?.[0];
    const alternative = result?.alternatives?.[0];

    return {
      text: alternative?.transcript ?? '',
      confidence: alternative?.confidence,
      language: request.language,
    };
  }

  private mapEncoding(contentType: string): string {
    if (contentType.includes('wav')) return 'LINEAR16';
    if (contentType.includes('flac')) return 'FLAC';
    if (contentType.includes('ogg')) return 'OGG_OPUS';
    if (contentType.includes('webm')) return 'WEBM_OPUS';
    return 'MP3';
  }
}
