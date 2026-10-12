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
import type { S2sConfig, S2sSession } from '../../types/S2sTypes';

@Injectable()
export class OpenAiRealtimeClient {
  private readonly logger = new Logger(OpenAiRealtimeClient.name);

  async createSession(_params: VoiceCallParams, _config: S2sConfig): Promise<S2sSession> {
    this.logger.warn('OpenAI Realtime S2S is a stub — WebSocket implementation deferred to phase 2');
    throw new Error('OpenAI Realtime S2S not yet implemented');
  }
}
