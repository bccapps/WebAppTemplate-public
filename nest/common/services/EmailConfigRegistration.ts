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
import { emailConfigSchema } from '../emailConfigSchema';
import { brandConfigSchema } from '../brandConfigSchema';
import { storageConfigSchema } from '../storageConfigSchema';

/**
 * Registers every `common` schema that describes how the app talks to the
 * outside world: the e-mail provider, the site identity / social channels
 * that outbound content is built from, and where inline images are stored.
 */
@Injectable()
export class EmailConfigRegistration implements OnApplicationBootstrap {
  constructor(private readonly moduleConfigService: ModuleConfigService) {}

  onApplicationBootstrap(): void {
    this.moduleConfigService.register(emailConfigSchema);
    this.moduleConfigService.register(brandConfigSchema);
    this.moduleConfigService.register(storageConfigSchema);
  }
}
