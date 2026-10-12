/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import ConfigurationEntity from '../entities/ConfigurationEntity';
import { defaultConfigEntries } from 'src/config/defaultConfig';

@Injectable()
export class ConfigSeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConfigSeederService.name);

  constructor(
    @InjectRepository(ConfigurationEntity)
    private readonly configurationRepository: Repository<ConfigurationEntity>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.configurationRepository.delete({ name: 'token_live_streaming_enabled' });

      // Migrate api_url_* entries seeded with bare '/api' to '/api/v1'
      const staleApiUrls = await this.configurationRepository.find({
        where: { value: '/api' },
      });
      for (const entry of staleApiUrls) {
        if (entry.name.startsWith('api_url_')) {
          entry.value = '/api/v1';
          await this.configurationRepository.save(entry);
        }
      }

      // Migrate api_url_tradingplatform to remote URL if still pointing to local
      const tpEntry = await this.configurationRepository.findOne({
        where: { name: 'api_url_tradingplatform', value: '/api/v1' },
      });
      if (tpEntry) {
        tpEntry.value = 'https://ctdapi-back.web3c.cc/api/v1';
        await this.configurationRepository.save(tpEntry);
      }

      // Normalize any api_url_* entries that have a bare https:// origin without /api/ path
      const allEntries = await this.configurationRepository.find();
      for (const entry of allEntries) {
        if (
          entry.name.startsWith('api_url_') &&
          (entry.value.startsWith('https://') || entry.value.startsWith('http://')) &&
          !entry.value.includes('/api/')
        ) {
          entry.value = entry.value.replace(/\/$/, '') + '/api/v1';
          await this.configurationRepository.save(entry);
        }
      }

      const existingNames = new Set(allEntries.map((item) => item.name));
      const toCreate = defaultConfigEntries.filter(
        (entry) => !existingNames.has(entry.name),
      );

      if (toCreate.length === 0) {
        return;
      }

      await this.configurationRepository.insert(
        toCreate.map(({ name, value, description }) => ({
          name,
          value,
          description: description ?? '',
        })),
      );

      this.logger.log(
        `Seeded ${toCreate.length} default configuration entr${
          toCreate.length > 1 ? 'ies' : 'y'
        }`,
      );
    } catch (error) {
      this.logger.error(
        'Failed to seed default configuration entries',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
