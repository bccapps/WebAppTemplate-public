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
export class AssemblyAiSttClient {
  private readonly logger = new Logger(AssemblyAiSttClient.name);

  async transcribe(params: VoiceCallParams, request: SttRequest): Promise<SttResponse> {
    const baseUrl = params.baseUrl.replace(/\/+$/, '');

    // Step 1: Upload audio
    const uploadRes = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': params.password ?? '',
        'Content-Type': 'application/octet-stream',
      },
      body: request.audio as unknown as BodyInit,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      this.logger.error(`AssemblyAI upload error: ${uploadRes.status} ${text}`);
      throw new Error(`AssemblyAI upload failed: ${uploadRes.status}`);
    }

    const { upload_url } = await uploadRes.json() as { upload_url: string };

    // Step 2: Create transcript
    const transcriptRes = await fetch(`${baseUrl}/transcript`, {
      method: 'POST',
      headers: {
        'Authorization': params.password ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: upload_url,
        ...(request.language ? { language_code: request.language } : { language_detection: true }),
      }),
    });

    if (!transcriptRes.ok) {
      const text = await transcriptRes.text();
      this.logger.error(`AssemblyAI transcript error: ${transcriptRes.status} ${text}`);
      throw new Error(`AssemblyAI transcript failed: ${transcriptRes.status}`);
    }

    const transcript = await transcriptRes.json() as { id: string };

    // Step 3: Poll for completion
    const result = await this.pollTranscript(baseUrl, params.password ?? '', transcript.id);

    const segments: SttSegment[] = (result.words ?? []).map((w: any) => ({
      text: w.text,
      startMs: w.start,
      endMs: w.end,
      confidence: w.confidence,
    }));

    return {
      text: result.text ?? '',
      confidence: result.confidence,
      segments,
      language: result.language_code,
    };
  }

  private async pollTranscript(baseUrl: string, apiKey: string, id: string, maxAttempts = 60): Promise<any> {
    for (let i = 0; i < maxAttempts; i++) {
      const res = await fetch(`${baseUrl}/transcript/${id}`, {
        headers: { 'Authorization': apiKey },
      });

      if (!res.ok) throw new Error(`AssemblyAI poll failed: ${res.status}`);
      const data = await res.json() as any;

      if (data.status === 'completed') return data;
      if (data.status === 'error') throw new Error(`AssemblyAI transcription error: ${data.error}`);

      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('AssemblyAI transcription timed out');
  }
}
