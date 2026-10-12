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
export class DeepgramSttClient {
  private readonly logger = new Logger(DeepgramSttClient.name);

  async transcribe(params: VoiceCallParams, request: SttRequest): Promise<SttResponse> {
    const baseUrl = params.baseUrl.replace(/\/+$/, '');
    const model = request.model ?? 'nova-2';
    const language = request.language ?? 'en';
    const url = `${baseUrl}/listen?model=${model}&language=${language}&punctuate=true&utterances=true`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${params.password}`,
        'Content-Type': request.contentType,
      },
      body: request.audio as unknown as BodyInit,
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`Deepgram STT error: ${res.status} ${text}`);
      throw new Error(`Deepgram STT failed: ${res.status}`);
    }

    const json = await res.json() as any;
    const channel = json.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];

    const segments: SttSegment[] = (alternative?.words ?? []).map((w: any) => ({
      text: w.word,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
      confidence: w.confidence,
    }));

    return {
      text: alternative?.transcript ?? '',
      confidence: alternative?.confidence,
      segments,
      language: json.results?.channels?.[0]?.detected_language,
    };
  }
}
