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
export class AmazonPollyClient {
  private readonly logger = new Logger(AmazonPollyClient.name);

  async synthesize(params: VoiceCallParams, request: TtsRequest): Promise<TtsResponse> {
    const region = params.providerConfig?.region ?? 'us-east-1';
    const baseUrl = params.baseUrl.replace('{region}', region).replace(/\/+$/, '');

    const body = JSON.stringify({
      Text: request.text,
      OutputFormat: this.mapFormat(request.outputFormat),
      VoiceId: request.voice ?? 'Joanna',
      ...(request.language ? { LanguageCode: request.language } : {}),
    });

    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    const res = await fetch(`${baseUrl}/v1/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Amz-Date': dateStamp,
        'Authorization': this.buildAuthHeader(params, region, body, dateStamp),
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`Amazon Polly error: ${res.status} ${text}`);
      throw new Error(`Amazon Polly failed: ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      contentType: this.getContentType(request.outputFormat),
    };
  }

  private buildAuthHeader(params: VoiceCallParams, region: string, _body: string, _date: string): string {
    // Simplified — production should use AWS Signature V4
    return `AWS4-HMAC-SHA256 Credential=${params.username}/${region}/polly/aws4_request`;
  }

  private mapFormat(format?: string): string {
    switch (format) {
      case 'ogg': return 'ogg_vorbis';
      case 'pcm': return 'pcm';
      default: return 'mp3';
    }
  }

  private getContentType(format?: string): string {
    switch (format) {
      case 'ogg': return 'audio/ogg';
      case 'pcm': return 'audio/pcm';
      default: return 'audio/mpeg';
    }
  }
}
