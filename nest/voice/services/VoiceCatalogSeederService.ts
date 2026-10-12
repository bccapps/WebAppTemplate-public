/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { VoiceProviderCatalogService } from './VoiceProviderCatalogService';
import { VOICE_PROVIDER_SEEDS } from '../data/seed-catalog';

@Injectable()
export class VoiceCatalogSeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VoiceCatalogSeederService.name);

  constructor(
    private readonly providerCatalogService: VoiceProviderCatalogService,
  ) {}

  async onApplicationBootstrap() {
    await this.seedProviders();
  }

  private async seedProviders() {
    let count = 0;
    for (const seed of VOICE_PROVIDER_SEEDS) {
      await this.providerCatalogService.upsertBySlug({
        name: seed.name,
        slug: seed.slug,
        type: seed.type,
        capabilities: seed.capabilities,
        baseUrl: seed.baseUrl,
        website: seed.website,
        signupUrl: seed.signupUrl,
      });
      count++;
    }
    this.logger.log(`Seeded ${count} voice provider catalog entries`);
  }
}
