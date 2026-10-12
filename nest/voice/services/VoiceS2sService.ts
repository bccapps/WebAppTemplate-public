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
import { DeepgramS2sClient } from './clients/DeepgramS2sClient';
import { ElevenLabsS2sClient } from './clients/ElevenLabsS2sClient';
import { GladiaS2sClient } from './clients/GladiaS2sClient';
import { OpenAiRealtimeClient } from './clients/OpenAiRealtimeClient';
import type { S2sConfig, S2sSession } from '../types/S2sTypes';
import type { VoiceCallParams } from '../types/VoiceCallParams';

@Injectable()
export class VoiceS2sService {
  constructor(
    private readonly accessService: VoiceAccessService,
    private readonly deepgram: DeepgramS2sClient,
    private readonly elevenLabs: ElevenLabsS2sClient,
    private readonly gladia: GladiaS2sClient,
    private readonly openAi: OpenAiRealtimeClient,
  ) {}

  async createSession(accessId: number, config: S2sConfig): Promise<S2sSession> {
    const access = await this.accessService.getAccessWithSecrets(accessId);
    if (!access) throw new NotFoundException('Voice access not found');

    const provider = access.provider;
    if (!provider) throw new BadRequestException('No provider linked to this access');
    if (!provider.capabilities.includes('s2s')) {
      throw new BadRequestException(`Provider "${provider.name}" does not support S2S`);
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
      case 'deepgram':
        return this.deepgram.createSession(params, config);
      case 'elevenlabs':
        return this.elevenLabs.createSession(params, config);
      case 'gladia':
        return this.gladia.createSession(params, config);
      case 'openai':
        return this.openAi.createSession(params, config);
      default:
        throw new BadRequestException(`Unsupported S2S provider type: ${provider.type}`);
    }
  }
}
