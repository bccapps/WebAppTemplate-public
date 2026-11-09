/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { VoiceCallParams } from '../../types/VoiceCallParams';
import type { TtsRequest, TtsResponse } from '../../types/TtsTypes';

/** `POST /v1/audio/speech` accepts at most 4096 characters of input. */
export const OPENAI_TTS_MAX_CHARS = 4096;
/** Default model (`providerConfig.model` overrides it). `tts-1` / `tts-1-hd` / `gpt-4o-mini-tts` are announced to shut down on 2027-01-06. */
export const OPENAI_TTS_DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'coral';
const TIMEOUT_MS = 30_000;

/** Request body of `/v1/audio/speech` (exposed for tests). */
export function buildOpenAiSpeechBody(params: VoiceCallParams, request: TtsRequest): Record<string, unknown> {
  const config = params.providerConfig ?? {};
  const model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : OPENAI_TTS_DEFAULT_MODEL;
  const body: Record<string, unknown> = {
    model,
    input: request.text,
    voice: request.voice ?? DEFAULT_VOICE,
    response_format: mapFormat(request.outputFormat),
  };
  // `instructions` is a gpt-4o-mini-tts feature and `speed` a tts-1 one: each is sent to the models that take it only.
  if (model.startsWith('gpt-') && typeof config.instructions === 'string' && config.instructions.trim()) {
    body.instructions = config.instructions.trim();
  }
  if (model.startsWith('tts-1') && request.speed && request.speed !== 1) {
    body.speed = Math.min(4, Math.max(0.25, request.speed));
  }
  return body;
}

/** `pcm` is raw 24 kHz 16-bit signed little-endian mono without header; `wav` is a RIFF/WAVE file. */
function mapFormat(format?: string): string {
  switch (format) {
    case 'wav': return 'wav';
    case 'pcm': return 'pcm';
    case 'ogg': return 'opus';
    default: return 'mp3';
  }
}

function contentTypeFor(format: unknown): string {
  switch (format) {
    case 'wav': return 'audio/wav';
    case 'pcm': return 'audio/L16;rate=24000;channels=1';
    case 'opus': return 'audio/ogg';
    default: return 'audio/mpeg';
  }
}

/** Text to speech with the OpenAI API (`/v1/audio/speech`); the key is `params.password`. */
@Injectable()
export class OpenAiTtsClient {
  private readonly logger = new Logger(OpenAiTtsClient.name);

  async synthesize(params: VoiceCallParams, request: TtsRequest): Promise<TtsResponse> {
    if (!request.text || request.text.length > OPENAI_TTS_MAX_CHARS) {
      throw new BadRequestException(`OpenAI TTS input must be 1..${OPENAI_TTS_MAX_CHARS} characters`);
    }
    const body = buildOpenAiSpeechBody(params, request);
    const res = await fetch(`${params.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${params.password ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      this.logger.error(`OpenAI TTS error: ${res.status} ${(await res.text()).slice(0, 300)}`);
      throw new Error(`OpenAI TTS failed: ${res.status}`);
    }
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: contentTypeFor(body.response_format) };
  }
}
