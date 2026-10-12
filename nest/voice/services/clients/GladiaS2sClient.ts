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
export class GladiaS2sClient {
  private readonly logger = new Logger(GladiaS2sClient.name);

  async createSession(_params: VoiceCallParams, _config: S2sConfig): Promise<S2sSession> {
    this.logger.warn('Gladia S2S is a stub — WebSocket implementation deferred to phase 2');
    throw new Error('Gladia S2S not yet implemented');
  }
}
