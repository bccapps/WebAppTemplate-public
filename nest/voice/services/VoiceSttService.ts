/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { VoiceAccessService } from './VoiceAccessService';
import { GoogleCloudSttClient } from './clients/GoogleCloudSttClient';
import { DeepgramSttClient } from './clients/DeepgramSttClient';
import { AssemblyAiSttClient } from './clients/AssemblyAiSttClient';
import { OpenAiWhisperClient } from './clients/OpenAiWhisperClient';
import type { SttRequest, SttResponse } from '../types/SttTypes';
import type { VoiceCallParams } from '../types/VoiceCallParams';

@Injectable()
export class VoiceSttService {
  constructor(
    private readonly accessService: VoiceAccessService,
    private readonly googleStt: GoogleCloudSttClient,
    private readonly deepgram: DeepgramSttClient,
    private readonly assemblyAi: AssemblyAiSttClient,
    private readonly whisper: OpenAiWhisperClient,
  ) {}

  async transcribe(accessId: number, request: SttRequest): Promise<SttResponse> {
    const access = await this.accessService.getAccessWithSecrets(accessId);
    if (!access) throw new NotFoundException('Voice access not found');

    const provider = access.provider;
    if (!provider) throw new BadRequestException('No provider linked to this access');
    if (!provider.capabilities.includes('stt')) {
      throw new BadRequestException(`Provider "${provider.name}" does not support STT`);
    }

    const params: VoiceCallParams = {
      accessId: access.id,
      label: access.label,
      type: provider.type,
      baseUrl: access.baseUrlOverride ?? provider.baseUrl,
      username: access.username,
      password: access.password,
      providerConfig: access.providerConfig,
    };

    switch (provider.type) {
      case 'google-cloud':
        return this.googleStt.transcribe(params, request);
      case 'deepgram':
        return this.deepgram.transcribe(params, request);
      case 'assemblyai':
        return this.assemblyAi.transcribe(params, request);
      case 'openai':
        return this.whisper.transcribe(params, request);
      default:
        throw new BadRequestException(`Unsupported STT provider type: ${provider.type}`);
    }
  }
}
