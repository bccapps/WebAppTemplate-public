/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleConfigService } from './ModuleConfigService';
import { commonConfigSchema } from '../configSchema';
import { donationsConfigSchema } from '../donationsConfigSchema';

@Injectable()
export class CommonConfigRegistration implements OnApplicationBootstrap {
  constructor(private readonly moduleConfigService: ModuleConfigService) {}

  onApplicationBootstrap(): void {
    this.moduleConfigService.register(commonConfigSchema);
    this.moduleConfigService.register(donationsConfigSchema);
  }
}
