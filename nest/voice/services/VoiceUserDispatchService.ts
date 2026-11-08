/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleConfigService } from '../../common/services/ModuleConfigService';
import { UserVoiceAccessService } from './UserVoiceAccessService';
import { GoogleCloudTtsClient } from './clients/GoogleCloudTtsClient';
import { AmazonPollyClient } from './clients/AmazonPollyClient';
import { AzureTtsClient } from './clients/AzureTtsClient';
import { ElevenLabsTtsClient } from './clients/ElevenLabsTtsClient';
import { GoogleCloudSttClient } from './clients/GoogleCloudSttClient';
import { DeepgramSttClient } from './clients/DeepgramSttClient';
import { AssemblyAiSttClient } from './clients/AssemblyAiSttClient';
import { OpenAiWhisperClient } from './clients/OpenAiWhisperClient';
import {
  defaultVoiceFor,
  localeFor,
  normalizeContentType,
  playableFormat,
  toCallParams,
  wavDurationMs,
  type AccessWithProvider,
} from './voiceUserDispatch';
import type { SttRequest, SttResponse } from '../types/SttTypes';
import type { TtsRequest, TtsResponse } from '../types/TtsTypes';

/**
 * Dispatch through a USER's own voice access (`user_voice_accesses`): the access must belong to the user (404 otherwise, never
 * "forbidden", so that ids of other users are not revealed) and `voice_allowUserProviders` must be on (403). Admin accesses keep
 * their own path (`VoiceTtsService` / `VoiceSttService`). The provider key (`password`) is read here and never logged or returned.
 */
@Injectable()
export class VoiceUserDispatchService {
  constructor(
    private readonly userAccesses: UserVoiceAccessService,
    private readonly config: ModuleConfigService,
    private readonly googleTts: GoogleCloudTtsClient,
    private readonly polly: AmazonPollyClient,
    private readonly azure: AzureTtsClient,
    private readonly elevenLabs: ElevenLabsTtsClient,
    private readonly googleStt: GoogleCloudSttClient,
    private readonly deepgram: DeepgramSttClient,
    private readonly assemblyAi: AssemblyAiSttClient,
    private readonly whisper: OpenAiWhisperClient,
  ) {}

  /** Whether users may use their own providers (`voice_allowUserProviders`). */
  isEnabled(): boolean {
    const value = this.config.getResolvedValue('voice_allowUserProviders');
    return value === true || value === 'true' || value === 1 || value === '1';
  }

  /**
   * Text to speech with the user's access. Asks the provider for a directly playable format (WAV, or raw PCM tagged
   * `audio/L16;rate=N;channels=1`); the whole buffer is returned (none of the clients streams).
   */
  async synthesize(userId: number, accessId: number, request: TtsRequest): Promise<TtsResponse> {
    const access = await this.owned(userId, accessId, 'tts');
    const type = access.provider!.type;
    const max = Number(this.config.getResolvedValue('voice_maxTtsChars')) || 5000;
    if (!request.text || request.text.length > max) {
      throw new BadRequestException(`Text must be 1..${max} characters`);
    }
    const language = localeFor(type, request.language);
    const prepared: TtsRequest = {
      ...request,
      language,
      voice: request.voice ?? defaultVoiceFor(type, request.language, request.gender, access.providerConfig),
      outputFormat: request.outputFormat ?? playableFormat(type),
    };
    const params = toCallParams(access);
    let out: TtsResponse;
    switch (type) {
      case 'google-cloud': out = await this.googleTts.synthesize(params, prepared); break;
      case 'aws-polly': out = await this.polly.synthesize(params, prepared); break;
      case 'azure-tts': out = await this.azure.synthesize(params, prepared); break;
      case 'elevenlabs': out = await this.elevenLabs.synthesize(params, prepared); break;
      default: throw new BadRequestException(`Unsupported TTS provider type: ${type}`);
    }
    const normalized = normalizeContentType(type, out.contentType);
    return {
      ...out,
      contentType: normalized.contentType,
      sampleRate: normalized.sampleRate ?? out.sampleRate,
      durationMs: out.durationMs ?? wavDurationMs(out.audio),
    };
  }

  /** Speech to text with the user's access. With no `language`, the provider detects it when it can (`language` of the result). */
  async transcribe(userId: number, accessId: number, request: SttRequest): Promise<SttResponse> {
    const access = await this.owned(userId, accessId, 'stt');
    const type = access.provider!.type;
    const maxMs = Number(this.config.getResolvedValue('voice_maxSttDurationMs')) || 300000;
    const duration = wavDurationMs(request.audio);
    if (duration !== undefined && duration > maxMs) {
      throw new BadRequestException(`Audio must not exceed ${maxMs} ms`);
    }
    if (!request.audio?.length) throw new BadRequestException('Empty audio');
    const prepared: SttRequest = {
      ...request,
      language: localeFor(type, request.language),
      detectLanguage: request.detectLanguage ?? !request.language,
    };
    const params = toCallParams(access);
    switch (type) {
      case 'google-cloud': return this.googleStt.transcribe(params, prepared);
      case 'deepgram': return this.deepgram.transcribe(params, prepared);
      case 'assemblyai': return this.assemblyAi.transcribe(params, prepared);
      case 'openai': return this.whisper.transcribe(params, prepared);
      default: throw new BadRequestException(`Unsupported STT provider type: ${type}`);
    }
  }

  private async owned(userId: number, accessId: number, capability: 'tts' | 'stt'): Promise<AccessWithProvider> {
    if (!this.isEnabled()) throw new ForbiddenException('User voice providers are disabled');
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(accessId)) throw new NotFoundException('Voice access not found');
    const access = await this.userAccesses.getAccessWithSecrets(userId, accessId);
    if (!access) throw new NotFoundException('Voice access not found');
    if (!access.provider) throw new BadRequestException('No provider linked to this access');
    if (!access.provider.capabilities.includes(capability)) {
      throw new BadRequestException(`Provider "${access.provider.name}" does not support ${capability.toUpperCase()}`);
    }
    return access;
  }
}
