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
import { FunctionalException } from '../exceptions/FunctionalException';
import { ConfigFieldSchema } from '../types/ModuleConfigSchema';
import { validateConfigFieldValue, validatePlainConfigValue } from '../utils/configValueValidation';
import { defaultConfigEntries } from 'src/config/defaultConfig';
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

  private findModuleField(name: string): ConfigFieldSchema | undefined {
    for (const schema of this.moduleConfigRegistry.getAllSchemas()) {
      const field = schema.fields.find((f) => f.key === name);
      if (field) return field;
    }
    return undefined;
  }

  /**
   * Admin entry point of `PUT /api/v1/configurations`: same write as `updateAll`, after checking the whole
   * payload (nothing is written when one entry is refused).
   *  - a `name` that is neither stored, nor in `defaultConfigEntries`, nor a registered module field is refused
   *    (`CFG_UNKNOWN_KEY`): this route edits existing keys, it does not create arbitrary ones;
   *  - an entry whose value equals the stored one is accepted as is (pages resend the whole list, and stored
   *    values may predate the schema);
   *  - a changed value of a module-schema field is validated against that field; an empty value on a `secret`
   *    field leaves the stored secret untouched, a non-empty one is refused (`CFG_SECRET_READONLY`): the secret
   *    would be stored unencrypted, secrets go through `PUT /admin/module-configs/:moduleId`.
   * Internal callers (module config service, seeders, other modules) keep using `updateAll`.
   */
  async updateFromAdmin(dtos: ConfigurationDto[]): Promise<ConfigurationDto[]> {
    if (!dtos || !Array.isArray(dtos)) return this.configDtos ?? [];
    const accepted: ConfigurationDto[] = [];
    for (const dto of dtos) {
      if (!dto?.name) continue;
      if (await this.checkAdminEntry(dto)) accepted.push(dto);
    }
    return this.updateAll(accepted);
  }

  /** Throws when the entry is refused; returns false when it must be skipped (secret left as is). */
  private async checkAdminEntry(dto: ConfigurationDto): Promise<boolean> {
    if (typeof dto.name !== 'string') {
      throw new FunctionalException('CFG_INVALID_FORMAT', 'Configuration name must be a string');
    }
    const stored = await this.configurationRepository.findOne({ where: { name: dto.name } });
    const field = this.findModuleField(dto.name);
    const known = stored || field || defaultConfigEntries.some((entry) => entry.name === dto.name);
    if (!known) throw new FunctionalException('CFG_UNKNOWN_KEY', `Unknown configuration key '${dto.name}'`);

    const value = dto.value ?? '';
    if (stored && String(stored.value) === String(value)) return true;

    if (field?.type === 'secret') {
      if (value === '') return false;
      throw new FunctionalException(
        'CFG_SECRET_READONLY',
        `Secret key '${dto.name}' cannot be changed here: use the module configuration endpoint`,
      );
    }
    const issue = field ? validateConfigFieldValue(field, value) : validatePlainConfigValue(value);
    if (issue) throw new FunctionalException(issue.code, `Invalid value for '${dto.name}': ${issue.reason}`);
    return true;
  }

  /**
   * update or create configuration variables (internal use: no validation, creates unknown names)
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
