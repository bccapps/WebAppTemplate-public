/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ModuleConfigService } from '../../common/services/ModuleConfigService';
import { voiceConfigSchema } from '../configSchema';

@Injectable()
export class VoiceConfigRegistrarService implements OnModuleInit {
  constructor(private readonly moduleConfigService: ModuleConfigService) {}

  onModuleInit(): void {
    this.moduleConfigService.register(voiceConfigSchema);
  }
}
