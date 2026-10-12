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
export class AzureTtsClient {
  private readonly logger = new Logger(AzureTtsClient.name);

  async synthesize(params: VoiceCallParams, request: TtsRequest): Promise<TtsResponse> {
    const region = params.providerConfig?.region ?? 'eastus';
    const baseUrl = params.baseUrl.replace('{region}', region).replace(/\/+$/, '');
    const url = `${baseUrl}/cognitiveservices/v1`;

    const voice = request.voice ?? 'en-US-JennyNeural';
    const lang = request.language ?? 'en-US';
    const rate = request.speed ? `${Math.round(request.speed * 100 - 100)}%` : '+0%';

    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">
  <voice name="${voice}">
    <prosody rate="${rate}">${this.escapeXml(request.text)}</prosody>
  </voice>
</speak>`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': params.password ?? '',
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': this.mapFormat(request.outputFormat),
      },
      body: ssml,
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`Azure TTS error: ${res.status} ${text}`);
      throw new Error(`Azure TTS failed: ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      contentType: this.getContentType(request.outputFormat),
    };
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private mapFormat(format?: string): string {
    switch (format) {
      case 'wav': return 'riff-24khz-16bit-mono-pcm';
      case 'ogg': return 'ogg-24khz-16bit-mono-opus';
      default: return 'audio-24khz-96kbitrate-mono-mp3';
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
