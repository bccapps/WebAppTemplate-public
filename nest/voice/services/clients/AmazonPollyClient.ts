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
import { signSigV4 } from './awsSigV4';

const DEFAULT_REGION = 'us-east-1';
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;
const ENGINES = ['standard', 'neural', 'long-form', 'generative'];
const TIMEOUT_MS = 30_000;

/** Region of the call: `providerConfig.region`, else the one in the base URL host (`polly.<region>.amazonaws.com`), else `us-east-1`. */
export function pollyRegion(baseUrl: string, providerConfig: Record<string, unknown> | null): string {
  const configured = providerConfig?.region;
  if (typeof configured === 'string' && REGION_PATTERN.test(configured.trim())) return configured.trim();
  const host = /^https?:\/\/polly\.([a-z0-9-]+)\.amazonaws\.com/.exec(baseUrl);
  return host && REGION_PATTERN.test(host[1]) ? host[1] : DEFAULT_REGION;
}

/** Endpoint URL: `{region}` placeholder replaced, and the region of a standard Polly host replaced by the configured one. */
export function pollyEndpoint(baseUrl: string, region: string): string {
  const url = baseUrl.replace('{region}', region).replace(/\/+$/, '');
  return url.replace(/^(https?:\/\/)polly\.[a-z0-9-]+(\.amazonaws\.com)/, `$1polly.${region}$2`);
}

/** Request body of `POST /v1/speech` (exposed for tests). */
export function buildPollyBody(params: VoiceCallParams, request: TtsRequest): Record<string, unknown> {
  const engine = params.providerConfig?.engine;
  return {
    Text: request.text,
    OutputFormat: mapFormat(request.outputFormat),
    VoiceId: request.voice ?? 'Joanna',
    ...(request.outputFormat === 'pcm' ? { SampleRate: '16000' } : {}),
    ...(request.language ? { LanguageCode: request.language } : {}),
    ...(typeof engine === 'string' && ENGINES.includes(engine) ? { Engine: engine } : {}),
  };
}

function mapFormat(format?: string): string {
  switch (format) {
    case 'ogg': return 'ogg_vorbis';
    case 'pcm': return 'pcm';
    default: return 'mp3';
  }
}

function contentTypeFor(format?: string): string {
  switch (format) {
    case 'ogg': return 'audio/ogg';
    case 'pcm': return 'audio/L16;rate=16000;channels=1';
    default: return 'audio/mpeg';
  }
}

/**
 * Amazon Polly (`POST /v1/speech`) signed with AWS Signature V4. The access key id is `params.username` and the secret access key
 * `params.password`; the region comes from `providerConfig.region`. PCM output is 16 kHz 16-bit mono.
 */
@Injectable()
export class AmazonPollyClient {
  private readonly logger = new Logger(AmazonPollyClient.name);

  async synthesize(params: VoiceCallParams, request: TtsRequest): Promise<TtsResponse> {
    if (!params.username || !params.password) {
      throw new BadRequestException('Amazon Polly needs an access key id (username) and a secret access key (password)');
    }
    const region = pollyRegion(params.baseUrl, params.providerConfig);
    const url = `${pollyEndpoint(params.baseUrl, region)}/v1/speech`;
    const body = JSON.stringify(buildPollyBody(params, request));
    const headers = signSigV4(
      { method: 'POST', url, headers: { 'content-type': 'application/json' }, body, region, service: 'polly' },
      { accessKeyId: params.username, secretAccessKey: params.password },
    );
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      this.logger.error(`Amazon Polly error: ${res.status} ${(await res.text()).slice(0, 300)}`);
      throw new Error(`Amazon Polly failed: ${res.status}`);
    }
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: contentTypeFor(request.outputFormat) };
  }
}
