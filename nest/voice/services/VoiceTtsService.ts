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
import { GoogleCloudTtsClient } from './clients/GoogleCloudTtsClient';
import { AmazonPollyClient } from './clients/AmazonPollyClient';
import { AzureTtsClient } from './clients/AzureTtsClient';
import { ElevenLabsTtsClient } from './clients/ElevenLabsTtsClient';
import type { TtsRequest, TtsResponse } from '../types/TtsTypes';
import type { VoiceCallParams } from '../types/VoiceCallParams';

@Injectable()
export class VoiceTtsService {
  constructor(
    private readonly accessService: VoiceAccessService,
    private readonly googleTts: GoogleCloudTtsClient,
    private readonly polly: AmazonPollyClient,
    private readonly azure: AzureTtsClient,
    private readonly elevenLabs: ElevenLabsTtsClient,
  ) {}

  async synthesize(accessId: number, request: TtsRequest): Promise<TtsResponse> {
    const access = await this.accessService.getAccessWithSecrets(accessId);
    if (!access) throw new NotFoundException('Voice access not found');

    const provider = access.provider;
    if (!provider) throw new BadRequestException('No provider linked to this access');
    if (!provider.capabilities.includes('tts')) {
      throw new BadRequestException(`Provider "${provider.name}" does not support TTS`);
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
        return this.googleTts.synthesize(params, request);
      case 'aws-polly':
        return this.polly.synthesize(params, request);
      case 'azure-tts':
        return this.azure.synthesize(params, request);
      case 'elevenlabs':
        return this.elevenLabs.synthesize(params, request);
      default:
        throw new BadRequestException(`Unsupported TTS provider type: ${provider.type}`);
    }
  }
}
