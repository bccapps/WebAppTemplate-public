/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import ConfigurationDto from '../dtos/ConfigurationDto';
import { ConfigurationMapper } from '../mappers/ConfigurationMapper';
import ConfigurationEntity from '../entities/ConfigurationEntity';
import { ModuleConfigRegistry } from './ModuleConfigRegistry';

@Injectable()
export class ConfigurationService implements OnApplicationBootstrap {
  config: { [id: string]: any } = {};
  configDtos: any = null;
  private cacheLoadedAt: number | null = null;
  private reloading: Promise<void> | null = null;

  constructor(
    @InjectRepository(ConfigurationEntity)
    private readonly configurationRepository: Repository<ConfigurationEntity>,
    private readonly configurationMapper: ConfigurationMapper,
    private readonly moduleConfigRegistry: ModuleConfigRegistry /*
    private readonly userService: UserService,
    private readonly blockchainService: BlockchainService
    */
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.getConfiguration();
  }

  /**
   * get configuration of app
   * @returns
   */
  async getConfiguration(): Promise<ConfigurationDto[]> {
    const shouldRefresh =
      this.configDtos == null
      || this.cacheLoadedAt == null
      || Date.now() - this.cacheLoadedAt > 5000;
    if (shouldRefresh) await this.reload();
    return this.configDtos;
  }

  /**
   * Reloads the cache from the database. The new map is built aside and swapped in one assignment: emptying
   * `this.config` first and refilling it after the query left a window where `get()` returned nothing, so every
   * reader (module switches included) fell back to its schema default — "all disabled" on any page that
   * reloaded the configuration alongside another call. Concurrent reloads share one query.
   */
  private reload(): Promise<void> {
    this.reloading ??= (async (): Promise<void> => {
      const entities = await this.configurationRepository.find();
      const dtos = this.configurationMapper.mapFromEntities(entities);
      const next: { [id: string]: any } = {};
      for (const elem of dtos) next[elem['name']] = elem['value'];
      this.configDtos = dtos;
      this.config = next;
      this.cacheLoadedAt = Date.now();
    })().finally((): void => { this.reloading = null; });
    return this.reloading;
  }

  /**
   * get a configuration variable value
   * @param
   */
  get(name: string): any {
    if (name in this.config) {
      return this.config[name];
    }
    // fallback env
    const envVal = process.env[name];
    if (envVal !== undefined) return envVal;
    return undefined;
  }

  /**
   * Returns all config keys owned by registered module config schemas.
   */
  private getModuleOwnedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const schema of this.moduleConfigRegistry.getAllSchemas()) {
      for (const field of schema.fields) {
        keys.add(field.key);
      }
    }
    return keys;
  }

  /**
   * Returns the set of keys that must never appear in the public GET /configurations response.
   * Includes: all module-config fields typed 'secret' + any key whose name contains a
   * known sensitive pattern (safety net for keys manually added to global config).
   */
  private getPublicBlockedKeys(): Set<string> {
    const blocked = new Set<string>();

    // Block all module-config secret fields.
    for (const schema of this.moduleConfigRegistry.getAllSchemas()) {
      for (const field of schema.fields) {
        if (field.type === 'secret') {
          blocked.add(field.key);
        }
      }
    }

    // Block any key name that contains a known sensitive pattern (case-insensitive).
    const SENSITIVE_PATTERNS = [
      'password', 'secret', 'private_key', 'privatekey',
      'apikey', 'api_key', 'bearertoken', 'bearer_token',
      'access_token', 'refresh_token', 'master_key',
      'adminwallets', 'admin_wallets',
    ];
    for (const dto of this.configDtos ?? []) {
      const lower = (dto.name as string).toLowerCase();
      if (SENSITIVE_PATTERNS.some((p) => lower.includes(p))) {
        blocked.add(dto.name);
      }
    }

    return blocked;
  }

  /**
   * Public endpoint response — excludes all module-config secret fields.
   */
  async getPublicConfiguration(): Promise<ConfigurationDto[]> {
    const all = await this.getConfiguration();
    const blocked = this.getPublicBlockedKeys();
    return all.filter((dto) => !blocked.has(dto.name));
  }

  /**
   * get configuration excluding module-owned keys and api_url_* (for the admin "General" tab)
   */
  async getGlobalConfiguration(): Promise<ConfigurationDto[]> {
    const all = await this.getConfiguration();
    const moduleKeys = this.getModuleOwnedKeys();
    return all.filter((dto) => !moduleKeys.has(dto.name) && !dto.name.startsWith('api_url_'));
  }

  /**
   * Returns only the api_url_* entries (module API URL management)
   */
  async getModuleUrls(): Promise<ConfigurationDto[]> {
    const all = await this.getConfiguration();
    return all.filter((dto) => dto.name.startsWith('api_url_'));
  }

  /**
   * update or create configuration variables
   */
  async updateAll(dtos: ConfigurationDto[]): Promise<ConfigurationDto[]> {
    if (!dtos || !Array.isArray(dtos)) return this.configDtos ?? [];
    for (const dto of dtos) {
      if (!dto?.name) continue;
      let entity = await this.configurationRepository.findOne({
        where: { name: dto.name },
      });
      if (!entity) {
        entity = this.configurationRepository.create({
          name: dto.name,
          description: dto.description ?? '',
          value: dto.value ?? '',
        });
      } else {
        entity.value = dto.value ?? '';
        entity.description = dto.description ?? entity.description;
      }
      await this.configurationRepository.save(entity);
    }
    // refresh cache (the previous values stay readable until the reload lands)
    this.cacheLoadedAt = null;
    return this.getConfiguration();
  }
}
